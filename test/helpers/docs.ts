// Fixture builders for native-parsing tests. PDFs and OOXML containers are
// synthesised byte-by-byte here rather than committed as binaries, so the
// tests state exactly which structures the parsers must read.

import { deflateRawSync } from "node:zlib";

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/* ---------------------------------- ZIP --------------------------------- */

interface ZipInput {
  name: string;
  data: string | Uint8Array;
  deflate?: boolean;
  /** Declared uncompressed size, when the fixture must lie about it. */
  declaredSize?: number;
}

export function buildZip(entries: ZipInput[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  const u16 = (arr: number[], v: number) => arr.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (arr: number[], v: number) =>
    arr.push(v & 0xff, (v >> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

  const cursor = () => local.length;

  for (const entry of entries) {
    const raw =
      typeof entry.data === "string" ? utf8.encode(entry.data) : entry.data;
    const deflated = entry.deflate === true;
    const body = deflated ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nameBytes = utf8.encode(entry.name);
    const offset = cursor();
    offsets.push(offset);

    u32(local, 0x04034b50);
    u16(local, 20);
    u16(local, 0);
    u16(local, deflated ? 8 : 0);
    u16(local, 0);
    u16(local, 0);
    u32(local, 0);
    u32(local, body.length);
    u32(local, entry.declaredSize ?? raw.length);
    u16(local, nameBytes.length);
    u16(local, 0);
    local.push(...nameBytes, ...body);
  }

  const cdOffset = local.length;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const raw =
      typeof entry.data === "string" ? utf8.encode(entry.data) : entry.data;
    const deflated = entry.deflate === true;
    const body = deflated ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nameBytes = utf8.encode(entry.name);

    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, 0);
    u16(central, deflated ? 8 : 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, body.length);
    u32(central, entry.declaredSize ?? raw.length);
    u16(central, nameBytes.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offsets[i]);
    central.push(...nameBytes);
  }

  const eocd: number[] = [];
  u32(eocd, 0x06054b50);
  u16(eocd, 0);
  u16(eocd, 0);
  u16(eocd, entries.length);
  u16(eocd, entries.length);
  u32(eocd, central.length);
  u32(eocd, cdOffset);
  u16(eocd, 0);

  return new Uint8Array([...local, ...central, ...eocd]);
}

/* ---------------------------------- PDF --------------------------------- */

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function utf16beHex(text: string): string {
  let hex = "";
  for (const ch of text) {
    hex += ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase();
  }
  return hex || "0000";
}

/**
 * One-page-per-string PDF with a Helvetica font (WinAnsi). Objects are
 * sequential and forward references are allowed: the parser must not rely
 * on an xref table.
 */
export function buildPdf(pageTexts: string[]): Uint8Array {
  const objects: string[] = [];
  const pageCount = Math.max(1, pageTexts.length);
  const fontNum = 3 + pageCount * 2;
  const kids = pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(" ");

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`,
  );
  pageTexts.forEach((text, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    const content = `BT /F1 12 Tf 72 712 Td (${pdfEscape(text)}) Tj ET`;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    );
  });
  objects.push(
    `${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );
  return utf8.encode(`%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`);
}

export function buildEncryptedPdfWithText(text: string): Uint8Array {
  const bytes = buildPdf([text]);
  const body = utf8Decoder.decode(bytes);
  return utf8.encode(body.replace("trailer", "trailer\n<< /Encrypt 99 0 R >>"));
}

/**
 * PDF using a Type0 font whose only decoding path is a ToUnicode CMap,
 * exercising bfchar. `codes` maps a two-byte code to its Unicode string;
 * `content` is the sequence of codes drawn on the page.
 */
export function buildPdfWithCmap(
  codes: Array<[number, string]>,
  content: number[],
): Uint8Array {
  const bfchar = codes
    .map(
      ([code, text]) =>
        `<${code.toString(16).padStart(4, "0").toUpperCase()}> <${utf16beHex(text)}>`,
    )
    .join("\n");
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${codes.length} beginbfchar`,
    bfchar,
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const hex = content
    .map((code) => code.toString(16).padStart(4, "0").toUpperCase())
    .join("");
  const stream = `BT /F1 12 Tf 72 712 Td <${hex}> Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H " +
      "/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>\nendobj\n",
    "6 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>\nendobj\n",
    `7 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n`,
  ];
  return utf8.encode(`%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`);
}

/* --------------------------------- OOXML -------------------------------- */

const DOCX_CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

export function docxXml(paragraphs: string[], table?: string[][]): string {
  const runs = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("");
  const tableXml = table
    ? `<w:tbl>${table
        .map(
          (row) =>
            `<w:tr>${row
              .map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`)
              .join("")}</w:tr>`,
        )
        .join("")}</w:tbl>`
    : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${runs}${tableXml}</w:body></w:document>`
  );
}

export function buildDocx(
  paragraphs: string[],
  options: { table?: string[][]; deflate?: boolean; omitBody?: boolean } = {},
): Uint8Array {
  const entries: ZipInput[] = [
    { name: "[Content_Types].xml", data: DOCX_CONTENT_TYPES },
  ];
  if (!options.omitBody) {
    entries.push({
      name: "word/document.xml",
      data: docxXml(paragraphs, options.table),
      deflate: options.deflate ?? true,
    });
  }
  return buildZip(entries);
}

/* --------------------------------- XLSX --------------------------------- */

export interface XlsxSheet {
  name: string;
  rows: Array<Array<string | number>>;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function xmlEscape(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => XML_ESCAPES[ch]);
}

/**
 * Minimal but valid XLSX: workbook, rels, shared strings and one worksheet
 * per sheet. String cells alternate shared/inline so both read paths are
 * exercised; numbers go in `<v>`.
 */
export function buildXlsx(
  sheets: XlsxSheet[],
  options: { deflate?: boolean } = {},
): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  let stringCount = 0;

  const sheetXml = (sheet: XlsxSheet): string => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value) => {
            if (typeof value === "number") return `<c><v>${value}</v></c>`;
            stringCount++;
            if (stringCount % 2 === 0) {
              return `<c t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
            }
            let index = sharedIndex.get(value);
            if (index === undefined) {
              index = shared.length;
              shared.push(value);
              sharedIndex.set(value, index);
            }
            return `<c t="s"><v>${index}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  };

  const workbook =
    '<?xml version="1.0"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map(
        (s, i) =>
          `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("") +
    "</sheets></workbook>";

  const rels =
    '<?xml version="1.0"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    "</Relationships>";

  const entries: ZipInput[] = [
    { name: "[Content_Types].xml", data: DOCX_CONTENT_TYPES },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: rels },
  ];
  sheets.forEach((sheet, i) => {
    entries.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(sheet),
      deflate: options.deflate ?? true,
    });
  });
  if (stringCount > 0) {
    entries.push({
      name: "xl/sharedStrings.xml",
      data:
        `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${stringCount}" uniqueCount="${shared.length}">` +
        shared.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join("") +
        "</sst>",
      deflate: true,
    });
  }
  return buildZip(entries);
}

/* --------------------------------- PPTX --------------------------------- */

export interface PptxSlide {
  title: string;
  bullets?: string[];
  table?: string[][];
}

function pptxShape(paragraphs: string[]): string {
  return (
    "<p:sp><p:txBody><a:bodyPr/>" +
    paragraphs
      .map((text) => `<a:p><a:r><a:t>${xmlEscape(text)}</a:t></a:r></a:p>`)
      .join("") +
    "</p:txBody></p:sp>"
  );
}

function pptxTable(rows: string[][]): string {
  return (
    "<p:graphicFrame><a:tbl>" +
    rows
      .map(
        (row) =>
          "<a:tr>" +
          row
            .map(
              (cell) =>
                `<a:tc><a:txBody><a:p><a:r><a:t>${xmlEscape(cell)}</a:t></a:r></a:p></a:txBody></a:tc>`,
            )
            .join("") +
          "</a:tr>",
      )
      .join("") +
    "</a:tbl></p:graphicFrame>"
  );
}

export function buildPptx(
  slides: PptxSlide[],
  options: { deflate?: boolean } = {},
): Uint8Array {
  const entries: ZipInput[] = [
    { name: "[Content_Types].xml", data: DOCX_CONTENT_TYPES },
  ];
  slides.forEach((slide, i) => {
    const body = [
      pptxShape([slide.title]),
      ...(slide.bullets ?? []).map((b) => pptxShape([b])),
      ...(slide.table ? [pptxTable(slide.table)] : []),
    ].join("");
    entries.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data:
        '<?xml version="1.0"?>' +
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        `<p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
      deflate: options.deflate ?? true,
    });
  });
  return buildZip(entries);
}
