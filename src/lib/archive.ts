// Native archive extraction (C4): ZIP members classify individually through
// the ingest lane classifier and supported ones parse with their own native
// parser, so an archive of PDFs and spreadsheets becomes searchable text
// without a model pass over the whole container. Unsafe paths are refused,
// nesting is bounded, per-member declared sizes and the total inflated
// budget are capped before inflation, and every skip or refusal is reported
// as an explicit marker in the text. A container nothing can be read from
// yields nothing, which the lane reads as "use the model pass".

import { classifyLane, MAX_DOC_BYTES } from "./ingest";
import { delimitedToText } from "./tables";
import { openZip } from "./zip";

/** Members processed from one archive before the truncation marker. */
export const MAX_ARCHIVE_MEMBERS = 500;
/** Archive nesting parsed below the top level (an archive in an archive). */
export const MAX_ARCHIVE_DEPTH = 1;
/** Total declared uncompressed bytes one archive tree may inflate to. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
/** Total characters one archive may contribute to the mirror. */
export const MAX_ARCHIVE_CHARS = 4 * 1024 * 1024;

/** Member text plus its native tier; null means the member did not parse. */
export interface MemberText {
  text: string;
  tier?: string;
}

/** How the archive reads a held-lane member (the native dispatch). */
export type MemberExtractor = (
  lane: string,
  bytes: Uint8Array,
) => Promise<MemberText | null>;

const utf8 = new TextDecoder("utf-8");

/** Reject anything that could escape the archive root when extracted. */
function unsafePath(name: string): string | null {
  if (name.includes("\0")) return "null byte";
  if (name.startsWith("/") || name.startsWith("\\")) return "absolute path";
  if (/^[A-Za-z]:/.test(name)) return "absolute path";
  if (name.split(/[/\\]/).includes("..")) return "path traversal";
  return null;
}

interface Sink {
  lines: string[];
  chars: number;
  stopped: boolean;
}

function push(sink: Sink, line: string): void {
  if (sink.stopped) return;
  if (sink.chars + line.length + 1 > MAX_ARCHIVE_CHARS) {
    sink.stopped = true;
    sink.lines.push(`[archive truncated at ${MAX_ARCHIVE_CHARS} characters]`);
    return;
  }
  sink.lines.push(line);
  sink.chars += line.length + 1;
}

function decodeText(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

async function readArchive(
  bytes: Uint8Array,
  extractMember: MemberExtractor,
  depth: number,
  sink: Sink,
  budget: { inflated: number },
): Promise<void> {
  const zip = await openZip(bytes);
  const names = zip.names();
  push(
    sink,
    `# Archive: ${names.length} member${names.length === 1 ? "" : "s"}`,
  );
  for (let i = 0; i < names.length; i++) {
    if (sink.stopped) return;
    if (i >= MAX_ARCHIVE_MEMBERS) {
      push(sink, `[archive truncated after ${MAX_ARCHIVE_MEMBERS} members]`);
      return;
    }
    const name = names[i];
    const info = zip.stat(name);
    const declared = info?.uncompressedSize ?? 0;
    const unsafe = unsafePath(name);
    if (unsafe) {
      push(sink, `## Member: ${name} (refused: unsafe path)`);
      continue;
    }
    const decision = classifyLane(name, "", declared);
    if (decision.lane === "rejected") {
      push(sink, `## Member: ${name} (refused: ${decision.reason})`);
      continue;
    }
    if (decision.lane === "held-ocr") {
      // Vision OCR is a whole-file lane; archive members do not go through it.
      push(sink, `## Member: ${name} (held-ocr, skipped: ${decision.reason})`);
      continue;
    }
    if (decision.lane === "held-archive") {
      if (depth >= MAX_ARCHIVE_DEPTH) {
        push(
          sink,
          `## Member: ${name} (refused: nesting limit ${MAX_ARCHIVE_DEPTH})`,
        );
        continue;
      }
      if (budget.inflated + declared > MAX_ARCHIVE_BYTES) {
        push(sink, `## Member: ${name} (refused: archive byte budget exhausted)`);
        continue;
      }
      let nested: Uint8Array | null;
      try {
        nested = await zip.read(name);
      } catch (err) {
        push(sink, `## Member: ${name} (held-archive, skipped: ${(err as Error).message})`);
        continue;
      }
      if (!nested) continue;
      budget.inflated += nested.length;
      if (nested.length > MAX_DOC_BYTES) {
        push(sink, `## Member: ${name} (refused: member inflates past the cap)`);
        continue;
      }
      try {
        await readArchive(nested, extractMember, depth + 1, sink, budget);
      } catch (err) {
        push(
          sink,
          `## Member: ${name} (held-archive, skipped: ${(err as Error).message})`,
        );
      }
      continue;
    }
    let member: Uint8Array | null;
    try {
      member = await zip.read(name);
    } catch (err) {
      push(sink, `## Member: ${name} (${decision.lane}, skipped: ${(err as Error).message})`);
      continue;
    }
    if (!member) continue;
    budget.inflated += member.length;
    if (member.length > MAX_DOC_BYTES) {
      push(sink, `## Member: ${name} (refused: member inflates past the cap)`);
      continue;
    }
    if (decision.lane === "native") {
      // CSV/TSV members get the same column-aware rows as the corpus route.
      const text = decision.table
        ? delimitedToText(decodeText(member), decision.table === "tsv" ? "\t" : ",")
        : decodeText(member);
      if (!text.trim()) {
        push(sink, `## Member: ${name} (native, skipped: extracted no text)`);
        continue;
      }
      push(sink, `## Member: ${name} (native)`);
      push(sink, text);
      continue;
    }
    const extracted = await extractMember(decision.lane, member).catch(
      () => null,
    );
    if (!extracted?.text.trim()) {
      push(sink, `## Member: ${name} (${decision.lane}, skipped: native parse failed)`);
      continue;
    }
    push(sink, `## Member: ${name} (${decision.lane}, parsed)`);
    push(sink, extracted.text);
  }
}

/**
 * Extract a ZIP archive tree. Never throws on member failures — each member
 * is classified, reported and skipped individually; malformed containers
 * throw, which the lane reads as "use the model pass".
 */
export async function extractArchiveText(
  bytes: Uint8Array,
  extractMember: MemberExtractor,
  depth = 0,
): Promise<string> {
  const sink: Sink = { lines: [], chars: 0, stopped: false };
  await readArchive(bytes, extractMember, depth, sink, { inflated: 0 });
  return sink.lines.join("\n");
}
