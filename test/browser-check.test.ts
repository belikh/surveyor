import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import {
  createPdfBrowserSeam,
  emptySeamCalls,
} from "./helpers/pdf-browser";
import {
  runPdfBrowserCheck,
  type BrowserDriver,
  type BrowserSession,
} from "../src/lib/browser";

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

const seam = createPdfBrowserSeam(async (path) => {
  const res = await callApp(path);
  return { status: res.status, text: await res.text() };
});

// The stub driver: no browser binary is installed in this environment, so
// the in-process PDF.js seam stands in for one. It implements the same
// BrowserDriver contract a real headless driver must, over the exact assets
// the installation serves.
function inProcessDriver(): BrowserDriver {
  return {
    name: "in-process-pdfjs",
    async launch(): Promise<BrowserSession> {
      const served = await seam.serveWorkerAsset("/pdf.worker.mjs");
      if (served.status !== 200) {
        throw new Error(`/pdf.worker.mjs HTTP ${served.status}`);
      }
      const calls = emptySeamCalls();
      const tools = await seam.boot(calls);
      return {
        async goto(path) {
          const res = await callApp(path);
          return { status: res.status, body: await res.text() };
        },
        extractText(pdf) {
          return tools.extractText(
            new Blob([pdf], { type: "application/pdf" }),
          );
        },
        async rasterise(pdf, maxPages) {
          const blobs = await tools.rasterise(
            new Blob([pdf], { type: "application/pdf" }),
            maxPages,
          );
          return Promise.all(
            blobs.map(async (b) => {
              const bytes = new Uint8Array(await b.arrayBuffer());
              return {
                mediaType: b.type,
                bytes: bytes.length,
                signature: [...bytes.slice(0, 8)],
              };
            }),
          );
        },
        async close() {},
      };
    },
  };
}

function overrideSession(
  base: BrowserDriver,
  patch: Partial<BrowserSession>,
): BrowserDriver {
  return {
    name: base.name,
    async launch(baseUrl) {
      return { ...(await base.launch(baseUrl)), ...patch };
    },
  };
}

describe("headless-browser PDF check (A6, #7)", () => {
  it("loads the shell and extracts and rasterises the fixture through the seam", async () => {
    const receipts = await runPdfBrowserCheck(
      inProcessDriver(),
      "https://surveyor.example",
    );
    expect(receipts.map((r) => `${r.status}:${r.name}`)).toEqual([
      "pass:browser:survey-shell",
      "pass:browser:pdf-text",
      "pass:browser:pdf-rasterise",
    ]);
  });

  it("fails visibly when the driver cannot launch", async () => {
    const driver: BrowserDriver = {
      name: "absent",
      async launch() {
        throw new Error("no headless browser installed");
      },
    };
    const receipts = await runPdfBrowserCheck(
      driver,
      "https://surveyor.example",
    );
    expect(receipts).toEqual([
      {
        name: "browser:driver",
        status: "fail",
        detail: expect.stringContaining("no headless browser installed"),
      },
    ]);
  });

  it("fails visibly when extraction returns the wrong text", async () => {
    const driver = overrideSession(inProcessDriver(), {
      extractText: async () => "something else",
    });
    const receipts = await runPdfBrowserCheck(
      driver,
      "https://surveyor.example",
    );
    const text = receipts.find((r) => r.name === "browser:pdf-text");
    expect(text?.status).toBe("fail");
    expect(text?.detail).toContain("Hello Surveyor");
    // The other receipts still report: one failure never hides the rest.
    expect(receipts.find((r) => r.name === "browser:pdf-rasterise")?.status).toBe(
      "pass",
    );
  });

  it("fails visibly when rasterisation returns no page image", async () => {
    const driver = overrideSession(inProcessDriver(), {
      rasterise: async () => [],
    });
    const receipts = await runPdfBrowserCheck(
      driver,
      "https://surveyor.example",
    );
    const raster = receipts.find((r) => r.name === "browser:pdf-rasterise");
    expect(raster?.status).toBe("fail");
    expect(raster?.detail).toMatch(/no PNG page image/);
  });

  it("fails visibly when the shell is not the survey shell", async () => {
    const driver = overrideSession(inProcessDriver(), {
      goto: async () => ({ status: 404, body: "not found" }),
    });
    const receipts = await runPdfBrowserCheck(
      driver,
      "https://surveyor.example",
    );
    expect(receipts.find((r) => r.name === "browser:survey-shell")?.status).toBe(
      "fail",
    );
  });
});
