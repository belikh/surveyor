// Delimited-table extraction (C5): CSV and TSV become the same row text the
// XLSX lane produces, so every table reaches the mirror column-aware and
// searchable. Parsing follows RFC 4180 quoting — quoted delimiters, escaped
// quotes and embedded newlines — and never throws: malformed quoting is read
// to the end of the input rather than failing the upload. Bounds reuse the
// sheet caps, with explicit truncation markers instead of silent loss.

import { MAX_SHEET_ROWS, MAX_TABLE_CHARS } from "./ooxml";

/** Rows read per table before the truncation marker. */
export const MAX_TABLE_ROWS = MAX_SHEET_ROWS;
export type Delimiter = "," | "\t";

/** RFC 4180-style parse into cells; a trailing newline adds no row. */
export function parseDelimited(raw: string, delimiter: Delimiter): string[][] {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
          continue;
        }
        quoted = false;
        continue;
      }
      cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Rows as pipe-joined cells under the same bounds as the XLSX lane. */
export function delimitedToText(raw: string, delimiter: Delimiter): string {
  const lines: string[] = [];
  let chars = 0;
  let count = 0;
  for (const row of parseDelimited(raw, delimiter)) {
    if (count >= MAX_TABLE_ROWS) {
      lines.push(`[table truncated after ${MAX_TABLE_ROWS} rows]`);
      break;
    }
    count++;
    const cells = row.map((cell) => cell.trim());
    if (cells.every((cell) => cell === "")) continue;
    const line = cells.join(" | ");
    if (chars + line.length > MAX_TABLE_CHARS) {
      lines.push(`[table truncated at ${MAX_TABLE_CHARS} characters]`);
      break;
    }
    chars += line.length + 1;
    lines.push(line);
  }
  return lines.join("\n");
}
