import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import {
  createPdfBrowserSeam,
  emptySeamCalls,
} from "./helpers/pdf-browser";
import { CONSOLE_JS } from "../src/frontend/console";
import { SURVEY_JS } from "../src/frontend/survey";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: "op-token",
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

async function callApp(path: string, init?: RequestInit) {
  return app.fetch(
    new Request(`https://surveyor.example${path}`, init),
    makeEnv() as never,
  );
}

function makePdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream =
    "BT /F1 18 Tf 20 100 Td (Hello Surveyor digital page with plenty of text to exceed the threshold) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const seam = createPdfBrowserSeam(async (path) => {
  const res = await callApp(path);
  return { status: res.status, text: await res.text() };
});

// F2 (#62): per-page hybrid PDF routing — no silent loss for mixed
// documents, digital-only keeps the single-text behaviour.
describe("hybrid PDF routing (F2)", () => {
  it("serves the hybrid helpers on the tools bundle", async () => {
    const js = await (await callApp("/pdf-tools.js")).text();
    for (const needle of [
      "analysePages",
      "extractPageTexts",
      "rasterisePages",
      "TEXT_PAGE_MIN",
    ]) {
      expect(js, needle).toContain(needle);
    }
  });

  it("analyses a digital-only page as text with no image leg", async () => {
    await seam.serveWorkerAsset("/pdf.worker.mjs");
    const tools = await seam.boot(emptySeamCalls());
    const pages = await tools.analysePages(
      new Blob([makePdf()], { type: "application/pdf" }),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].hasText).toBe(true);
    expect(pages[0].hasImage).toBe(false);
    // Digital-only keeps the single-text behaviour: one text, no raster leg.
    const texts = await tools.extractPageTexts(
      new Blob([makePdf()], { type: "application/pdf" }),
    );
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Hello Surveyor");
  });

  it("rasterises selected pages only", async () => {
    await seam.serveWorkerAsset("/pdf.worker.mjs");
    const tools = await seam.boot(emptySeamCalls());
    const rendered = await tools.rasterisePages(
      new Blob([makePdf()], { type: "application/pdf" }),
      [1],
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0].page).toBe(1);
    expect(rendered[0].blob.type).toBe("image/png");
  });

  it("console corpus section routes mixed PDFs to text plus scanned pages and says so", () => {
    for (const needle of [
      "analysePages",
      "rasterisePages",
      "Mixed PDF",
      "Sent text (",
      "scanned pages",
    ]) {
      expect(CONSOLE_JS, needle).toContain(needle);
    }
  });

  it("source survey mirrors the hybrid routing", () => {
    for (const needle of ["analysePages", "rasterisePages", "Mixed PDF"]) {
      expect(SURVEY_JS, needle).toContain(needle);
    }
  });
});
