// Native OOXML text extraction: OOXML files are ZIP containers of XML
// parts, so parsing needs no model pass and no third-party library. Only
// the parts that carry evidence text are read. Anything malformed throws;
// the lane treats that as "native parse failed" and falls back to the
// model pass.

import { openZip } from "./zip";
import { scanXml } from "./xml";

const utf8 = new TextDecoder("utf-8");

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
