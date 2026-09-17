// Minimal in-memory R2 facade for route tests. Accepts the shapes the
// Worker passes: Uint8Array/ArrayBuffer (direct and multipart puts) and
// ReadableStream (the declared-length streamed upload path).

async function toBytes(
  value: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const chunks: Uint8Array[] = [];
  const reader = value.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    if (chunk) chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class FakeR2 {
  private store = new Map<string, Uint8Array>();
  /** Byte length of every multipart part uploaded, for memory-bound assertions. */
  partSizes: number[] = [];

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  ): Promise<void> {
    this.store.set(key, await toBytes(value));
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const v = this.store.get(key);
    if (!v) return null;
    return {
      arrayBuffer: async () =>
        v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  async createMultipartUpload(key: string) {
    const self = this;
    const parts = new Map<number, Uint8Array>();
    return {
      key,
      uploadId: crypto.randomUUID(),
      uploadPart: async (
        partNumber: number,
        value: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
      ) => {
        const bytes = await toBytes(value);
        self.partSizes.push(bytes.byteLength);
        parts.set(partNumber, bytes);
        return { partNumber, etag: `etag-${partNumber}` };
      },
      complete: async (uploaded: Array<{ partNumber: number }>) => {
        const ordered = uploaded.map((p) => {
          const bytes = parts.get(p.partNumber);
          if (!bytes) throw new Error(`missing multipart part ${p.partNumber}`);
          return bytes;
        });
        // R2's rule: every part but the last is at least 5 MiB. The fake
        // enforces it so a smaller PART_BYTES cannot pass unnoticed.
        const MIN_PART_BYTES = 5 * 1024 * 1024;
        for (const part of ordered.slice(0, -1)) {
          if (part.byteLength < MIN_PART_BYTES) {
            throw new Error("multipart part below the R2 minimum of 5 MiB");
          }
        }
        const total = ordered.reduce((n, b) => n + b.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const b of ordered) {
          out.set(b, offset);
          offset += b.byteLength;
        }
        self.store.set(key, out);
        return { key, etag: "etag" };
      },
      abort: async () => {
        parts.clear();
      },
    };
  }
}
