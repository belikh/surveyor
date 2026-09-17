// Audio/video transcription lane. Workers AI `whisper-large-v3-turbo` via
// the AI binding is the keyless default (research:
// docs/research/audio-transcription-options.md §6.1: lowest published price,
// richest default provenance of the keyless models, no new vendor). Media
// reaches the AI binding inline only, so the drain slices held bytes into
// bounded chunks with an overlap window and stitches the per-chunk text
// into one ordered transcript. A failed or malformed chunk never yields a
// partial transcript: the whole file stays held with the chunk named, so
// the operator can retry or route it to the BYOK rescue lane (C7).

/** Keyless default: cheapest published ASR tier on Workers AI. */
export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Per-chunk byte budget. Cloudflare's documented long-audio pattern uses
 *  1 MB chunks; the binding input is inline, so this is also the transient
 *  encode budget per model call. */
export const TRANSCRIBE_CHUNK_BYTES = 1024 * 1024;

/** Overlap window so a word cut at a chunk boundary appears whole in the
 *  next chunk; the stitcher drops the duplicated run. */
export const TRANSCRIBE_OVERLAP_BYTES = 64 * 1024;

/** Per-file ceiling on model calls: a file needing more chunks stays held
 *  with a reason instead of burning the day's free neurons on one
 *  recording. A 25 MB file (the ingest cap) needs ~27 default chunks, so
 *  this bounds files routed by other lanes (attachments) too. */
export const MAX_TRANSCRIBE_CHUNKS = 32;

export interface ChunkPlanOptions {
  chunkBytes?: number;
  overlapBytes?: number;
  /** Per-file ceiling, in chunks. */
  maxChunks?: number;
}

export interface MediaChunkRange {
  index: number;
  /** Byte range within the media, end-exclusive. */
  start: number;
  end: number;
}

/**
 * Byte ranges covering `size` with overlap: each chunk starts inside the
 * previous one so a cut word is re-read by the next call. Planning is pure;
 * the caller slices the held bytes.
 */
export function planMediaChunks(
  size: number,
  opts: ChunkPlanOptions = {},
): MediaChunkRange[] {
  if (size <= 0) return [];
  const chunkBytes = Math.max(
    1,
    Math.floor(opts.chunkBytes ?? TRANSCRIBE_CHUNK_BYTES),
  );
  // Overlap strictly below the chunk size, so every chunk advances.
  const overlap = Math.max(
    0,
    Math.min(
      Math.floor(opts.overlapBytes ?? TRANSCRIBE_OVERLAP_BYTES),
      chunkBytes - 1,
    ),
  );
  const ranges: MediaChunkRange[] = [];
  let start = 0;
  for (;;) {
    const end = Math.min(start + chunkBytes, size);
    ranges.push({ index: ranges.length, start, end });
    if (end >= size) break;
    start = end - overlap;
  }
  return ranges;
}

/** The most words a stitcher will drop as a duplicated overlap run. */
const MAX_OVERLAP_WORDS = 16;

/**
 * Append the next chunk's text to the transcript, dropping the longest run
 * of words already at the tail of the accumulated text (the read-ahead the
 * overlap window produced). Bounded so a coincidental repetition later in
 * a recording is not eaten.
 */
export function stitchTranscript(acc: string, next: string): string {
  const before = acc.split(/\s+/).filter(Boolean);
  const after = next.split(/\s+/).filter(Boolean);
  const limit = Math.min(MAX_OVERLAP_WORDS, before.length, after.length);
  let dup = 0;
  for (let n = limit; n > 0; n--) {
    const tail = before.slice(before.length - n).join(" ").toLowerCase();
    const head = after.slice(0, n).join(" ").toLowerCase();
    if (tail === head) {
      dup = n;
      break;
    }
  }
  return [...before, ...after.slice(dup)].join(" ");
}

export type ChunkRunner = (
  model: string,
  inputs: Record<string, unknown>,
) => Promise<unknown>;

export interface ChunkTranscript extends MediaChunkRange {
  text: string;
}

export interface Transcription {
  text: string;
  model: string;
  /** Per-chunk text with its byte range: the lane's provenance record. */
  chunks: ChunkTranscript[];
}

export type TranscribeOutcome =
  | { ok: true; transcription: Transcription }
  | { ok: false; reason: string };

/** Base64 for an inline binding input (chunk-sized, so the string stays small). */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

/** `@cf/openai/whisper*` replies `{text, ...}`; anything else is malformed. */
function transcriptionText(raw: unknown): string | null {
  const out = raw as { text?: unknown } | null;
  return typeof out?.text === "string" ? out.text : null;
}

/**
 * Transcribe held media through the keyless model. Returns a held reason —
 * never a partial transcript — when a chunk fails or replies without text,
 * and refuses over-cap media before the first model call.
 */
export async function transcribeMedia(
  run: ChunkRunner,
  source: Uint8Array,
  opts: ChunkPlanOptions = {},
): Promise<TranscribeOutcome> {
  const ranges = planMediaChunks(source.length, opts);
  const maxChunks = opts.maxChunks ?? MAX_TRANSCRIBE_CHUNKS;
  if (ranges.length > maxChunks) {
    return {
      ok: false,
      reason:
        `transcription needs ${ranges.length} chunks, above the per-file ` +
        `cap of ${maxChunks} — split the recording or transcribe a lower-bitrate copy`,
    };
  }
  let text = "";
  const chunks: ChunkTranscript[] = [];
  for (const range of ranges) {
    let raw: unknown;
    try {
      raw = await run(TRANSCRIBE_MODEL, {
        audio: toBase64(source.subarray(range.start, range.end)),
      });
    } catch (err) {
      return {
        ok: false,
        reason:
          `transcription failed on chunk ${range.index + 1} of ` +
          `${ranges.length}: ${(err as Error)?.message ?? err}`,
      };
    }
    const part = transcriptionText(raw);
    if (part === null) {
      return {
        ok: false,
        reason:
          `transcription returned no text for chunk ${range.index + 1} of ` +
          `${ranges.length}`,
      };
    }
    chunks.push({ ...range, text: part });
    text = stitchTranscript(text, part);
  }
  return { ok: true, transcription: { text, model: TRANSCRIBE_MODEL, chunks } };
}
