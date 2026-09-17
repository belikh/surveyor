import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import {
  createPdfBrowserSeam,
  emptySeamCalls,
} from "./helpers/pdf-browser";

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

// A real, minimal PDF with a digital text layer ("Hello Surveyor"), built
// here so the test carries its own evidence rather than a binary fixture.
function makePdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 100 Td (Hello Surveyor) Tj ET";
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

async function serveWorkerAssets() {
  const res = await seam.serveWorkerAsset("/pdf.worker.mjs");
  expect(res.status, "/pdf.worker.mjs must be served").toBe(200);
}

describe("browser PDF path (A5, #6)", () => {
  it("serves the PDF worker asset from the worker route", async () => {
    const res = await callApp("/pdf.worker.mjs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js.length).toBeGreaterThan(500_000);
    // The asset is the PDF.js worker, not a copy of the main tools bundle.
    expect(js).toContain("WorkerMessageHandler");
    expect(js).not.toContain("SurveyorPdf");
  });

  it("points the served tools bundle at the same-origin worker route", async () => {
    const js = await (await callApp("/pdf-tools.js")).text();
    // The absolute route, not PDF.js's relative "./pdf.worker.mjs" default.
    expect(js).toContain('"/pdf.worker.mjs"');
  });

  it("extracts a real PDF's text layer through the browser seam", async () => {
    await serveWorkerAssets();
    const calls = emptySeamCalls();
    const tools = await seam.boot(calls);
    const text = await tools.extractText(
      new Blob([makePdf()], { type: "application/pdf" }),
    );
    expect(text).toContain("Hello Surveyor");
    // The worker came from the served asset route, not a CDN or fallback.
    expect(calls.workerUrls).toEqual(["/pdf.worker.mjs"]);
  });

  it("rasterises pages to page images through the browser seam", async () => {
    await serveWorkerAssets();
    const calls = emptySeamCalls();
    const tools = await seam.boot(calls);
    const blobs = await tools.rasterise(
      new Blob([makePdf()], { type: "application/pdf" }),
    );
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("image/png");
    expect(blobs[0].size).toBeGreaterThan(0);
    // A canvas was created and drawn to: text plus PNG encode steps.
    expect(calls.canvases).toBe(1);
    expect([...calls.ctxMethods]).toEqual(
      expect.arrayContaining(["fillText", "transform"]),
    );
  });
});
