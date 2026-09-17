// The mirror's membership rule, in one place. Corpus rows whose gated text
// is searchable and citable carry a settled status: native parse, vision
// OCR, the model rescue lane, or audio transcription (C6). Held, rejected
// and pending rows are never mirror material, and an unexamined row is
// never clean.

export const MIRROR_STATUSES = [
  "parsed",
  "OCRed",
  "rescued",
  "transcribed",
] as const;

/** SQL predicate over an unqualified `status` column. */
export const MIRRORED_SQL = `status IN (${MIRROR_STATUSES.map(
  (s) => `'${s}'`,
).join(", ")})`;

/** Whether a drain outcome settles a document (mirrored, citable, countable). */
export function isSettledStatus(status: string): boolean {
  return (MIRROR_STATUSES as readonly string[]).includes(status);
}
