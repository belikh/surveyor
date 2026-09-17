/// <reference lib="dom" />
// Browser-side PDF tools for the corpus uploader and the submitter survey.
// Self-hosted PDF.js (no third-party origin): extract a digital text layer,
// or rasterise scanned pages to PNGs for the server vision lane. Bundled to
// dist/pdf-tools.txt and served from the installation at /pdf-tools.js.
// The worker half is self-hosted too: dist/pdf.worker.txt is served at
// /pdf.worker.mjs, the same origin, so PDF.js never reaches a CDN.

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

async function load(file: Blob): Promise<pdfjs.PDFDocumentProxy> {
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
}

/** Extract the digital text layer; empty string when the PDF is a scan. */
async function extractText(file: Blob): Promise<string> {
  const doc = await load(file);
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

/** Per-page text layer, one entry per page, trimmed. */
async function extractPageTexts(file: Blob): Promise<string[]> {
  const doc = await load(file);
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    page.cleanup();
  }
  return out;
}

/** Operator-list image ops: any of these means the page carries raster content. */
const IMAGE_OP_NAMES = [
  "paintImageXObject",
  "paintInlineImageXObject",
  "paintImageMaskXObject",
  "paintImageXObjectRepeat",
  "paintInlineImageXObjectGroup",
  "paintImageXObjectGroup",
  "paintImageMaskXObjectGroup",
] as const;

async function pageHasImage(
  page: pdfjs.PDFPageProxy,
  textLength: number,
): Promise<boolean> {
  try {
    const ops = await page.getOperatorList();
    const seen = new Set<number>(ops.fnArray as number[]);
    const OPS = pdfjs.OPS as unknown as Record<string, number>;
    for (const name of IMAGE_OP_NAMES) {
      if (typeof OPS[name] === "number" && seen.has(OPS[name])) return true;
    }
    return false;
  } catch {
    // Operator list unavailable (worker stub in tests): fall back to the
    // text heuristic so scanned pages still route to raster.
    return textLength < TEXT_PAGE_MIN;
  }
}

/** Minimum trimmed chars for a page to count as text-bearing. */
export const TEXT_PAGE_MIN = 20;

export interface PageAnalysis {
  /** 1-indexed page number. */
  page: number;
  text: string;
  hasText: boolean;
  hasImage: boolean;
}

/**
 * Per-page hybrid analysis (F2): each page routes by content, so a mixed
 * PDF (digital text plus scanned tables or images) no longer silently
 * drops its raster portions.
 */
async function analysePages(file: Blob): Promise<PageAnalysis[]> {
  const doc = await load(file);
  const out: PageAnalysis[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const hasImage = await pageHasImage(page, text.length);
    out.push({ page: i, text, hasText: text.length >= TEXT_PAGE_MIN, hasImage });
    page.cleanup();
  }
  return out;
}

/** Rasterise one page to a PNG blob for vision OCR. */
async function rasteriseOne(
  doc: pdfjs.PDFDocumentProxy,
  pageNum: number,
): Promise<Blob | null> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) throw new Error("canvas unavailable");
  await page.render({ canvasContext, viewport, canvas }).promise;
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  page.cleanup();
  return blob;
}

/** Rasterise up to `maxPages` pages to PNG blobs for vision OCR. */
async function rasterise(file: Blob, maxPages = 50): Promise<Blob[]> {
  const doc = await load(file);
  const pages = Math.min(doc.numPages, maxPages);
  const blobs: Blob[] = [];
  for (let i = 1; i <= pages; i++) {
    const blob = await rasteriseOne(doc, i);
    if (blob) blobs.push(blob);
  }
  return blobs;
}

/**
 * Rasterise only the given 1-indexed pages (hybrid path: the image-bearing
 * pages of a mixed PDF). Returns `{ page, blob }` pairs in page order.
 */
async function rasterisePages(
  file: Blob,
  pages: number[],
  maxPages = 50,
): Promise<Array<{ page: number; blob: Blob }>> {
  const doc = await load(file);
  const wanted = [...new Set(pages)]
    .filter((p) => p >= 1 && p <= doc.numPages)
    .sort((a, b) => a - b)
    .slice(0, maxPages);
  const out: Array<{ page: number; blob: Blob }> = [];
  for (const p of wanted) {
    const blob = await rasteriseOne(doc, p);
    if (blob) out.push({ page: p, blob });
  }
  return out;
}

async function pageCount(file: Blob): Promise<number> {
  const doc = await load(file);
  return doc.numPages;
}

(window as unknown as Record<string, unknown>).SurveyorPdf = {
  extractText,
  extractPageTexts,
  analysePages,
  rasterise,
  rasterisePages,
  pageCount,
  TEXT_PAGE_MIN,
};
