// Native OOXML text extraction: OOXML files are ZIP containers of XML
// parts, so parsing needs no model pass and no third-party library. Only
// the parts that carry evidence text are read. A part that cannot be
// opened or decoded throws; the lane treats that as "native parse failed"
// and falls back to the model pass. Malformed markup inside a part ends
// the XML scan with what was read so far (see xml.ts), so a truncated
// container yields partial text rather than a fallback.
//
// Fidelity boundaries, flagged rather than hidden:
// - XLSX is sampled at MAX_SHEET_ROWS rows per sheet and MAX_TABLE_CHARS
//   characters in total, with a truncation marker written into the text;
// - PPTX text runs carry no layout (ADR-0002's accepted loss);
// - malformed or truncated markup yields the text scanned before the break;
// - comments, notes and macros are not read.

import { openZip, type ZipArchive } from "./zip";
import { scanXml } from "./xml";

const utf8 = new TextDecoder("utf-8");

/** Rows read per sheet before the sample marker. */
export const MAX_SHEET_ROWS = 5000;
/** Total characters one workbook or deck may contribute. */
export const MAX_TABLE_CHARS = 4 * 1024 * 1024;

/**
 * DOCX body text: one line per paragraph, table rows as pipe-joined cells.
 * Word splits runs mid-word, so runs concatenate without separators.
 */
export function docxPartToText(xml: string): string {
  const lines: string[] = [];
  let paragraph = "";
  let inText = false;
  let inParagraph = false;
  let inCell = false;
  let row: string[] | null = null;
  let cell = "";

  const flushParagraph = () => {
    if (!inParagraph) return;
    const text = paragraph.replace(/[ \t]+$/, "");
    paragraph = "";
    if (inCell) {
      cell += (cell ? "\n" : "") + text;
    } else if (text.trim()) {
      lines.push(text);
    }
  };

  scanXml(xml, (e) => {
    if (e.kind === "open") {
      switch (e.name) {
        case "w:p":
          inParagraph = true;
          paragraph = "";
          break;
        case "w:t":
          inText = true;
          break;
        case "w:tab":
          paragraph += "\t";
          break;
        case "w:br":
        case "w:cr":
          paragraph += "\n";
          break;
        case "w:tc":
          inCell = true;
          cell = "";
          break;
        case "w:tr":
          row = [];
          break;
      }
    } else if (e.kind === "close") {
      switch (e.name) {
        case "w:t":
          inText = false;
          break;
        case "w:p":
          flushParagraph();
          inParagraph = false;
          break;
        case "w:tc":
          flushParagraph();
          inCell = false;
          if (row) row.push(cell.trim());
          cell = "";
          break;
        case "w:tr":
          if (row) {
            lines.push(row.join(" | "));
            row = null;
          }
          break;
      }
    } else if (inText) {
      paragraph += e.text;
    }
  });
  flushParagraph();
  return lines.join("\n");
}

export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  const part = await zip.read("word/document.xml");
  if (!part) throw new Error("DOCX body part word/document.xml is missing");
  return docxPartToText(utf8.decode(part));
}

/* --------------------------------- XLSX --------------------------------- */

function sharedStringsPart(xml: string): string[] {
  const out: string[] = [];
  let current = "";
  let inItem = false;
  let inText = false;
  scanXml(xml, (e) => {
    if (e.kind === "open") {
      if (e.name === "si") {
        inItem = true;
        current = "";
      } else if (e.name === "t" && inItem) {
        inText = true;
      }
    } else if (e.kind === "close") {
      if (e.name === "t") {
        inText = false;
      } else if (e.name === "si") {
        out.push(current);
        inItem = false;
      }
    } else if (inText) {
      current += e.text;
    }
  });
  return out;
}

async function readSharedStrings(zip: ZipArchive): Promise<string[]> {
  const part = await zip.read("xl/sharedStrings.xml");
  return part ? sharedStringsPart(utf8.decode(part)) : [];
}

function sheetNumber(part: string): number {
  const m = /sheet(\d+)\.xml$/.exec(part);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Sheet name → part path, via workbook rels; falls back to part order. */
async function workbookSheets(
  zip: ZipArchive,
): Promise<Array<{ name: string; part: string }>> {
  const rels = new Map<string, string>();
  const relPart = await zip.read("xl/_rels/workbook.xml.rels");
  if (relPart) {
    scanXml(utf8.decode(relPart), (e) => {
      if (e.kind !== "open" || e.name !== "Relationship") return;
      const id = e.attrs.Id;
      const target = e.attrs.Target;
      if (!id || !target) return;
      rels.set(
        id,
        target.startsWith("/")
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, "")}`,
      );
    });
  }
  const sheets: Array<{ name: string; part: string }> = [];
  const workbook = await zip.read("xl/workbook.xml");
  if (workbook) {
    scanXml(utf8.decode(workbook), (e) => {
      if (e.kind !== "open" || e.name !== "sheet") return;
      const name = e.attrs.name;
      const part = rels.get(e.attrs["r:id"] ?? "");
      if (name && part) sheets.push({ name, part });
    });
  }
  if (sheets.length > 0) return sheets;
  return zip
    .names()
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b))
    .map((part, i) => ({ name: `Sheet${i + 1}`, part }));
}

function cellText(type: string, value: string, shared: string[]): string {
  if (type === "s") {
    const index = Number.parseInt(value, 10);
    return Number.isInteger(index) ? shared[index] ?? "" : "";
  }
  if (type === "e") return "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return value;
}

/**
 * Worksheet rows as pipe-joined cells, prefixed by a sheet heading. Reads
 * shared and inline strings, numbers, booleans and formula results; rows
 * past the sample cap become one truncation marker.
 */
export function worksheetPartToLines(xml: string, shared: string[]): string[] {
  const lines: string[] = [];
  let cells: string[] = [];
  let value = "";
  let type = "";
  let inValue = false;
  let inInline = false;
  let rows = 0;
  let chars = 0;
  let truncated = false;
  scanXml(xml, (e) => {
    if (e.kind === "open") {
      switch (e.name) {
        case "row":
          cells = [];
          break;
        case "c":
          type = e.attrs.t ?? "";
          value = "";
          break;
        case "v":
          inValue = true;
          break;
        case "is":
          inInline = true;
          break;
        case "t":
          if (inInline) inValue = true;
          break;
      }
    } else if (e.kind === "close") {
      switch (e.name) {
        case "v":
        case "t":
          inValue = false;
          break;
        case "is":
          inInline = false;
          break;
        case "c": {
          const text = cellText(type, value, shared);
          if (text) cells.push(text);
          break;
        }
        case "row": {
          if (truncated) break;
          if (rows >= MAX_SHEET_ROWS) {
            lines.push(`[sheet truncated after ${MAX_SHEET_ROWS} rows]`);
            truncated = true;
            break;
          }
          rows++;
          if (cells.length === 0) break;
          const line = cells.join(" | ");
          if (chars + line.length > MAX_TABLE_CHARS) {
            lines.push(`[sheet truncated at ${MAX_TABLE_CHARS} characters]`);
            truncated = true;
            break;
          }
          chars += line.length + 1;
          lines.push(line);
          break;
        }
      }
    } else if (inValue) {
      value += e.text;
    }
  });
  return lines;
}

export async function extractXlsxText(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  const shared = await readSharedStrings(zip);
  const sheets = await workbookSheets(zip);
  if (sheets.length === 0) {
    throw new Error("XLSX has no worksheet parts");
  }
  const lines: string[] = [];
  for (const sheet of sheets) {
    const part = await zip.read(sheet.part);
    if (!part) continue;
    lines.push(`# Sheet: ${sheet.name}`);
    lines.push(...worksheetPartToLines(utf8.decode(part), shared));
  }
  return lines.join("\n");
}

/* --------------------------------- PPTX --------------------------------- */

/**
 * One slide's text: a numbered heading, then paragraphs in shape order,
 * with table rows as pipe-joined cells.
 */
export function slidePartToText(xml: string, number: number): string {
  const lines: string[] = [`# Slide ${number}`];
  let paragraph = "";
  let inText = false;
  let inParagraph = false;
  let cell: string[] | null = null;
  let row: string[] | null = null;
  const flushParagraph = () => {
    if (!inParagraph) return;
    const text = paragraph.trim();
    paragraph = "";
    if (!text) return;
    if (cell) cell.push(text);
    else lines.push(text);
  };
  scanXml(xml, (e) => {
    if (e.kind === "open") {
      switch (e.name) {
        case "a:p":
          inParagraph = true;
          paragraph = "";
          break;
        case "a:t":
          inText = true;
          break;
        case "a:tc":
          cell = [];
          break;
        case "a:tr":
          row = [];
          break;
      }
    } else if (e.kind === "close") {
      switch (e.name) {
        case "a:t":
          inText = false;
          break;
        case "a:p":
          flushParagraph();
          inParagraph = false;
          break;
        case "a:tc":
          if (row && cell) row.push(cell.join("\n"));
          cell = null;
          break;
        case "a:tr":
          if (row) lines.push(row.join(" | "));
          row = null;
          break;
      }
    } else if (inText) {
      paragraph += e.text;
    }
  });
  flushParagraph();
  return lines.join("\n");
}

export async function extractPptxText(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b));
  if (slides.length === 0) {
    throw new Error("PPTX has no slide parts");
  }
  const parts: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const part = await zip.read(slides[i]);
    if (!part) continue;
    parts.push(slidePartToText(utf8.decode(part), i + 1));
  }
  return parts.join("\n\n");
}
