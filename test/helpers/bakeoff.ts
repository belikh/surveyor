// OCR accuracy bake-off (D8, #51): the measured comparison of extraction
// paths over a fixture corpus. This module is the runbook core — the
// evidence in `evidence/ocr-accuracy/` is a run of it, and
// `test/bakeoff.test.ts` re-runs it to prove the numbers reproduce.
//
// Fixtures are synthesised deterministically from their published ground
// truth with the same builders the native-parser tests use, so no binaries
// are committed and every fixture's bytes are hashed into the results.
//
// Only deterministic paths are measured here: the native parsers and the
// PDF.js text layer the browser lane uses. The model lanes (`toMarkdown`
// fallback, vision OCR) cannot be measured without a live Workers AI
// account; they are recorded in `GAPS`, never as numbers.

import { createHash } from "node:crypto";
import { buildDocx, buildPdf, buildPptx, buildXlsx, buildZip } from "./docs";
import { extractNativeText } from "../../src/lib/native";

export const REPRODUCE_COMMAND = "npm run bakeoff:ocr";

/* ------------------------------ fixture builds ------------------------------ */

function utf16beHex(text: string): string {
  let hex = "";
  for (const ch of text) {
    hex += ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase();
  }
  return hex || "0000";
}

/**
 * A Type0 font whose only decoding path is a ToUnicode CMap. Fuller than
 * the C1 test fixture (CIDToGIDMap, widths, descriptor), because PDF.js
 * needs those to read the font at all — the bake-off compares PDF.js
 * against the native parser on the same bytes.
 */
function buildCmapPdf(text: string): Uint8Array {
  const codes = [...text].map((ch, i) => [0x1000 + i, ch] as [number, string]);
  const bfchar = codes
    .map(
      ([code, ch]) =>
        `<${code.toString(16).padStart(4, "0").toUpperCase()}> <${utf16beHex(ch)}>`,
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
  const hex = codes
    .map(([code]) => code.toString(16).padStart(4, "0").toUpperCase())
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
      "/CIDToGIDMap /Identity /DW 1000 /FontDescriptor 8 0 R " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>\nendobj\n",
    `7 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n`,
    "8 0 obj\n<< /Type /FontDescriptor /FontName /Custom /Flags 4 " +
      "/FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 " +
      "/CapHeight 700 /StemV 80 >>\nendobj\n",
  ];
  return new TextEncoder().encode(
    `%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );
}

/** A page with drawing operators only: the scan case, no text layer. */
function buildVectorPdf(): Uint8Array {
  const stream = "0 0 100 100 re f";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  return new TextEncoder().encode(
    `%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );
}

/**
 * LZW (PDF flavour: MSB-first codes, early change) for text short enough
 * that the code width never leaves 9 bits. PDF.js decodes it; the native
 * parser's documented filter set (Flate/ASCIIHex/ASCII85) does not, which
 * is exactly the difference this fixture measures.
 */
function lzwEncode(text: string): Uint8Array {
  const bytes = [...new TextEncoder().encode(text)];
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  let next = 258;
  const codes: number[] = [256];
  let w = String.fromCharCode(bytes[0]);
  for (let i = 1; i < bytes.length; i++) {
    const k = String.fromCharCode(bytes[i]);
    const wk = w + k;
    if (dict.has(wk)) {
      w = wk;
      continue;
    }
    codes.push(dict.get(w)!);
    if (next < 512) dict.set(wk, next++);
    w = k;
  }
  if (w) codes.push(dict.get(w)!);
  codes.push(257);
  const bits: number[] = [];
  for (const code of codes) {
    for (let b = 8; b >= 0; b--) bits.push((code >> b) & 1);
  }
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    if (bit) out[i >> 3] |= 0x80 >> (i & 7);
  });
  return out;
}

/** A PDF whose content stream is LZW-filtered. Assembled from bytes, not a
 *  string, so the binary stream survives intact. */
function buildLzwPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`;
  const body = lzwEncode(content);
  const parts: Array<Uint8Array | string> = [
    "%PDF-1.4\n",
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${body.length} /Filter /LZWDecode >>\nstream\n`,
    body,
    "\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
  ];
  const encoder = new TextEncoder();
  const chunks = parts.map((part) =>
    typeof part === "string" ? encoder.encode(part) : part,
  );
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A DOCX whose single run carries a tab and a line break. */
function buildInlineRunDocx(): Uint8Array {
  const xml =
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:body><w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>" +
    "</w:body></w:document>";
  return buildZip([
    { name: "word/document.xml", data: xml, deflate: true },
  ]);
}

/* ---------------------------------- corpus ---------------------------------- */

export interface BakeoffFixture {
  id: string;
  lane: string;
  format: string;
  /** What limit or behaviour this fixture puts a path under. */
  stresses: string;
  /** `text`: a text layer the path should reproduce; `empty-layer`: the
   *  path must produce nothing (the file belongs to the OCR lane). */
  expect: "text" | "empty-layer";
  /** The text a perfect extraction returns (empty for `empty-layer`). */
  ground_truth: string;
  /** Path ids this fixture is fair to measure (non-PDF fixtures are
   *  native-only: PDF.js has nothing to read). */
  applies: string[];
  build: () => Uint8Array;
}

export const CORPUS: readonly BakeoffFixture[] = [
  {
    id: "pdf-plain",
    lane: "held-pdf",
    format: "PDF",
    stresses: "one-line digital text layer",
    expect: "text",
    ground_truth: "Personnel roster for the Wynnum site",
    applies: ["native-pdf", "pdfjs-text"],
    build: () => buildPdf(["Personnel roster for the Wynnum site"]),
  },
  {
    id: "pdf-multipage",
    lane: "held-pdf",
    format: "PDF",
    stresses: "page order and punctuation across three pages",
    expect: "text",
    ground_truth:
      "Wynnum roster - day shift Wynnum roster - night shift " +
      "Reviewed by the delegate 14/03/2026",
    applies: ["native-pdf", "pdfjs-text"],
    build: () =>
      buildPdf([
        "Wynnum roster - day shift",
        "Wynnum roster - night shift",
        "Reviewed by the delegate 14/03/2026",
      ]),
  },
  {
    id: "pdf-cmap",
    lane: "held-pdf",
    format: "PDF",
    stresses: "Type0 font decoded only through a ToUnicode CMap (non-ASCII)",
    expect: "text",
    ground_truth: "Café roster (Site 3)",
    applies: ["native-pdf", "pdfjs-text"],
    build: () => buildCmapPdf("Café roster (Site 3)"),
  },
  {
    id: "pdf-scanlike",
    lane: "held-pdf",
    format: "PDF",
    stresses: "no text layer: vector content only, the vision-OCR case",
    expect: "empty-layer",
    ground_truth: "",
    applies: ["native-pdf", "pdfjs-text"],
    build: () => buildVectorPdf(),
  },
  {
    id: "pdf-lzw",
    lane: "held-pdf",
    format: "PDF",
    stresses:
      "LZW-filtered content stream: outside the native parser's filter set, " +
      "so it must fall back to the model lane; PDF.js reads it",
    expect: "text",
    ground_truth: "LZW encoded delegate brief",
    applies: ["native-pdf", "pdfjs-text"],
    build: () => buildLzwPdf("LZW encoded delegate brief"),
  },
  {
    id: "docx-paragraphs",
    lane: "held-docx",
    format: "DOCX",
    stresses: "paragraphs plus a table (pipe-joined cells)",
    expect: "text",
    ground_truth:
      "Site roster Reviewed by the delegate " +
      "Wynnum Wharf | Delegate Night shift | 14/03/2026",
    applies: ["native-docx"],
    build: () =>
      buildDocx(["Site roster", "Reviewed by the delegate"], {
        table: [
          ["Wynnum Wharf", "Delegate"],
          ["Night shift", "14/03/2026"],
        ],
      }),
  },
  {
    id: "docx-inline",
    lane: "held-docx",
    format: "DOCX",
    stresses: "tabs and line breaks inside one run",
    expect: "text",
    ground_truth: "A B C",
    applies: ["native-docx"],
    build: buildInlineRunDocx,
  },
  {
    id: "xlsx-sheet",
    lane: "held-xlsx",
    format: "XLSX",
    stresses: "two sheets, shared and inline strings, numbers",
    expect: "text",
    ground_truth:
      "# Sheet: Roster Site | Delegate Wynnum Wharf | Night shift " +
      "Headcount | 42 # Sheet: Totals Total | 45",
    applies: ["native-xlsx"],
    build: () =>
      buildXlsx([
        {
          name: "Roster",
          rows: [
            ["Site", "Delegate"],
            ["Wynnum Wharf", "Night shift"],
            ["Headcount", 42],
          ],
        },
        { name: "Totals", rows: [["Total", 45]] },
      ]),
  },
  {
    id: "pptx-slides",
    lane: "held-pptx",
    format: "PPTX",
    stresses: "titles, bullets and a table across two slides",
    expect: "text",
    ground_truth:
      "# Slide 1 Evidence timeline Call 09:15 Site visit 11:00 " +
      "Date | Event 14/03/2026 | Delegate meeting " +
      "# Slide 2 Next steps Interview scheduled",
    applies: ["native-pptx"],
    build: () =>
      buildPptx([
        {
          title: "Evidence timeline",
          bullets: ["Call 09:15", "Site visit 11:00"],
          table: [
            ["Date", "Event"],
            ["14/03/2026", "Delegate meeting"],
          ],
        },
        { title: "Next steps", bullets: ["Interview scheduled"] },
      ]),
  },
];

/* ---------------------------------- paths ----------------------------------- */

export interface BakeoffPath {
  id: string;
  what: string;
  kind: "deterministic" | "model";
}

export const PATHS: readonly BakeoffPath[] = [
  {
    id: "native-pdf",
    what: "dependency-free native PDF parser through the lane dispatch (src/lib/pdf.ts)",
    kind: "deterministic",
  },
  {
    id: "native-docx",
    what: "dependency-free native DOCX parser (src/lib/ooxml.ts)",
    kind: "deterministic",
  },
  {
    id: "native-xlsx",
    what: "dependency-free native XLSX parser (src/lib/ooxml.ts)",
    kind: "deterministic",
  },
  {
    id: "native-pptx",
    what: "dependency-free native PPTX parser (src/lib/ooxml.ts)",
    kind: "deterministic",
  },
  {
    id: "pdfjs-text",
    what:
      "PDF.js text layer (the browser lane's library and version, run " +
      "in-process mirroring src/frontend/pdf-tools-entry.ts; not a browser run)",
    kind: "deterministic",
  },
];

/** The lanes this environment cannot measure: recorded, never estimated. */
export const GAPS = [
  {
    path: "workers-ai-toMarkdown",
    what: "env.AI.toMarkdown document-conversion fallback in the drain lane (src/lib/drain.ts)",
    reason:
      "requires a live Workers AI binding on a deployed Cloudflare account, " +
      "which this environment does not have",
    fixtures: [
      "any format the native lanes cannot parse (office variants, form XObjects, model-only containers)",
    ],
    measured: false,
  },
  {
    path: "workers-ai-vision-ocr",
    what: "vision-model OCR over browser-rasterised scan pages (ADR-0011)",
    reason:
      "requires a live Workers AI account and a browser rasterisation run; " +
      "neither is available in this environment",
    fixtures: ["pdf-scanlike"],
    measured: false,
  },
];

/* --------------------------------- metrics ---------------------------------- */

export function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Two-row Levenshtein distance over arrays (characters or words). */
function distance<T>(a: readonly T[], b: readonly T[]): number {
  let previous = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

function round(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

export interface TextMetrics {
  exact: boolean;
  char_accuracy: number;
  word_accuracy: number;
  chars_out: number;
  words_out: number;
}

export function textMetrics(groundTruth: string, output: string): TextMetrics {
  const gt = normalise(groundTruth);
  const out = normalise(output);
  const gtChars = [...gt];
  const outChars = [...out];
  const gtWords = gt ? gt.split(" ") : [];
  const outWords = out ? out.split(" ") : [];
  const charDistance = distance(gtChars, outChars);
  const wordDistance = distance(gtWords, outWords);
  return {
    exact: gt === out,
    char_accuracy: round(1 - charDistance / Math.max(gtChars.length, 1)),
    word_accuracy: round(1 - wordDistance / Math.max(gtWords.length, 1)),
    chars_out: output.length,
    words_out: outWords.length,
  };
}

/* ---------------------------------- runner ---------------------------------- */

export interface Measurement {
  fixture: string;
  path: string;
  lane: string;
  expected: "text" | "empty-layer";
  outcome: "text" | "empty" | "error";
  exact: boolean;
  char_accuracy: number | null;
  word_accuracy: number | null;
  chars_out: number;
  words_out: number;
  error: string | null;
}

export interface PathSummary {
  path: string;
  fixtures: number;
  exact: number;
  mean_char_accuracy: number;
  mean_word_accuracy: number;
}

export interface CorpusEntry {
  id: string;
  lane: string;
  format: string;
  stresses: string;
  expect: string;
  ground_truth: string;
  applies: string[];
  bytes: number;
  sha256: string;
}

export interface BakeoffResults {
  corpus: CorpusEntry[];
  paths: BakeoffPath[];
  measurements: Measurement[];
  summary: PathSummary[];
  gaps: typeof GAPS;
  reproduce: string;
  version: number;
}

const NATIVE_LANES: Record<string, string> = {
  "native-pdf": "held-pdf",
  "native-docx": "held-docx",
  "native-xlsx": "held-xlsx",
  "native-pptx": "held-pptx",
};

async function pdfjsText(bytes: Uint8Array): Promise<string> {
  // Dynamic import: the PDF.js package is large, and only the PDF fixtures
  // need it. The joining mirrors src/frontend/pdf-tools-entry.ts exactly.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // `isEvalSupported` mirrors src/frontend/pdf-tools-entry.ts. It is a real
  // runtime option but missing from pdfjs-dist's published types, so the
  // literal carries the parameter cast.
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0]).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out +=
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim() + "\n\n";
    page.cleanup();
  }
  return out.trim();
}

async function runPath(pathId: string, lane: string, bytes: Uint8Array): Promise<string> {
  if (pathId === "pdfjs-text") return pdfjsText(bytes);
  const nativeLane = NATIVE_LANES[pathId];
  if (!nativeLane || nativeLane !== lane) {
    throw new Error(`fixture lane ${lane} is not applicable to ${pathId}`);
  }
  const parsed = await extractNativeText(lane, bytes);
  return parsed?.text ?? "";
}

/**
 * Run the published corpus through every applicable path. Deterministic by
 * construction: fixture bytes come from the definitions, the parsers are
 * pure, and no clock, network or randomness is read.
 */
export async function runBakeoff(): Promise<BakeoffResults> {
  const corpus: CorpusEntry[] = [];
  const measurements: Measurement[] = [];
  for (const fixture of CORPUS) {
    const bytes = fixture.build();
    corpus.push({
      id: fixture.id,
      lane: fixture.lane,
      format: fixture.format,
      stresses: fixture.stresses,
      expect: fixture.expect,
      ground_truth: fixture.ground_truth,
      applies: [...fixture.applies],
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    for (const pathId of fixture.applies) {
      let output = "";
      let error: string | null = null;
      try {
        output = await runPath(pathId, fixture.lane, bytes);
      } catch (err) {
        error = String((err as Error)?.message ?? err);
      }
      const outcome: Measurement["outcome"] =
        error !== null ? "error" : normalise(output) ? "text" : "empty";
      const metrics =
        fixture.expect === "text"
          ? textMetrics(fixture.ground_truth, error !== null ? "" : output)
          : null;
      measurements.push({
        fixture: fixture.id,
        path: pathId,
        lane: fixture.lane,
        expected: fixture.expect,
        outcome,
        exact:
          fixture.expect === "text"
            ? metrics!.exact
            : outcome === "empty",
        char_accuracy: metrics?.char_accuracy ?? null,
        word_accuracy: metrics?.word_accuracy ?? null,
        chars_out: metrics?.chars_out ?? 0,
        words_out: metrics?.words_out ?? 0,
        error,
      });
    }
  }
  const summary: PathSummary[] = PATHS.map((path) => {
    const rows = measurements.filter((m) => m.path === path.id);
    const scored = rows.filter((m) => m.char_accuracy !== null);
    const mean = (pick: (m: Measurement) => number) =>
      scored.length === 0
        ? 0
        : Number(
            (
              scored.reduce((n, m) => n + pick(m), 0) / scored.length
            ).toFixed(4),
          );
    return {
      path: path.id,
      fixtures: rows.length,
      exact: rows.filter((m) => m.exact).length,
      mean_char_accuracy: mean((m) => m.char_accuracy as number),
      mean_word_accuracy: mean((m) => m.word_accuracy as number),
    };
  });
  return {
    version: 1,
    reproduce: REPRODUCE_COMMAND,
    corpus,
    paths: [...PATHS],
    measurements,
    summary,
    gaps: GAPS,
  };
}
