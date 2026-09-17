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

/** Rasterise up to `maxPages` pages to PNG blobs for vision OCR. */
async function rasterise(file: Blob, maxPages = 50): Promise<Blob[]> {
  const doc = await load(file);
  const pages = Math.min(doc.numPages, maxPages);
  const blobs: Blob[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
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
    if (blob) blobs.push(blob);
    page.cleanup();
  }
  return blobs;
}

async function pageCount(file: Blob): Promise<number> {
  const doc = await load(file);
  return doc.numPages;
}

(window as unknown as Record<string, unknown>).SurveyorPdf = {
  extractText,
  rasterise,
  pageCount,
};
