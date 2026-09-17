// Minimal ZIP container reader for OOXML parts (DOCX/XLSX/PPTX). It reads
// the central directory and inflates entries through the platform
// DecompressionStream, so no third-party zip dependency enters the Worker
// bundle. Malformed containers throw; lanes treat that as "native parse
// failed" and fall back to the model pass.
//
// Zip-bomb guard: an entry whose declared uncompressed size exceeds the
// archive cap is refused before inflation, and the inflated result is
// checked again.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

/** Most bytes one OOXML part may inflate to (zip-bomb guard). */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const utf8 = new TextDecoder("utf-8");

function u16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function u32(b: Uint8Array, off: number): number {
  return (
    (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
  );
}

/** Inflate a raw (headerless) deflate stream. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ZipArchive {
  /** Entry names in central-directory order. */
  names(): string[];
  /** Declared sizes for one entry, without inflating it (cap checks). */
  stat(name: string): ZipEntryInfo | null;
  /** Inflated bytes for one entry, or null when it does not exist. */
  read(name: string): Promise<Uint8Array | null>;
}

/**
 * Open a ZIP archive. Directory entries are kept out of `names()`;
 * unsupported compression methods throw when read, never silently.
 */
export async function openZip(bytes: Uint8Array): Promise<ZipArchive> {
  const min = Math.max(0, bytes.length - MAX_COMMENT_BYTES - EOCD_MIN_BYTES);
  let eocd = -1;
  for (let i = bytes.length - EOCD_MIN_BYTES; i >= min; i--) {
    if (u32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive: no end record");
  const count = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);
  if (cdOffset >= bytes.length) throw new Error("ZIP central directory out of range");

  const entries = new Map<string, CentralEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== CENTRAL_SIG) {
      throw new Error("ZIP central directory is malformed");
    }
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name && !name.endsWith("/")) {
      entries.set(name, {
        name,
        method: u16(bytes, p + 10),
        compressedSize: u32(bytes, p + 20),
        uncompressedSize: u32(bytes, p + 24),
        localOffset: u32(bytes, p + 42),
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: () => [...entries.keys()],
    stat: (name: string) => {
      const e = entries.get(name);
      return e
        ? {
            name: e.name,
            method: e.method,
            compressedSize: e.compressedSize,
            uncompressedSize: e.uncompressedSize,
          }
        : null;
    },
    read: async (name: string) => {
      const e = entries.get(name);
      if (!e) return null;
      if (e.uncompressedSize > MAX_ENTRY_BYTES) {
        throw new Error(`ZIP entry ${name} exceeds the uncompressed cap`);
      }
      const at = e.localOffset;
      if (at + 30 > bytes.length || u32(bytes, at) !== LOCAL_SIG) {
        throw new Error(`ZIP entry ${name} has no local header`);
      }
      const nameLen = u16(bytes, at + 26);
      const extraLen = u16(bytes, at + 28);
      const start = at + 30 + nameLen + extraLen;
      const end = start + e.compressedSize;
      if (end > bytes.length) throw new Error(`ZIP entry ${name} is truncated`);
      const data = bytes.subarray(start, end);
      if (e.method === 0) return data;
      if (e.method === 8) {
        const out = await inflateRaw(data);
        if (out.length > MAX_ENTRY_BYTES) {
          throw new Error(`ZIP entry ${name} inflated past the cap`);
        }
        return out;
      }
      throw new Error(`unsupported ZIP compression method ${e.method}`);
    },
  };
}
