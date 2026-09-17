import { describe, it, expect } from "vitest";
import vm from "node:vm";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

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

class DOMMatrixStub {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  constructor(init?: number[] | Record<string, number>) {
    if (Array.isArray(init)) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    } else if (init) {
      Object.assign(this, init);
    }
  }
  multiplySelf() {
    return this;
  }
  translateSelf() {
    return this;
  }
  scaleSelf() {
    return this;
  }
  invertSelf() {
    return this;
  }
}

class ImageDataStub {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
    if (a instanceof Uint8ClampedArray) {
      this.data = a;
      this.width = b;
      this.height = c ?? 0;
    } else {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    }
  }
}

class Path2DStub {
  addPath() {}
  moveTo() {}
  lineTo() {}
  rect() {}
  closePath() {}
}

interface SeamCalls {
  ctxMethods: Set<string>;
  workerUrls: string[];
  canvases: number;
}

// Worker assets served by the installation, keyed by route. The Worker
// boundary below looks the asset up by the URL PDF.js asks for, so a wrong
// workerSrc fails loudly instead of quietly falling back.
const workerAssets = new Map<string, string>();

// Structured clone into the receiving realm: typed arrays must satisfy the
// receiver's `instanceof Uint8Array`, exactly as a browser's postMessage
// recreates them in the destination realm.
function realmCloner(ctx: vm.Context) {
  const typed = [
    "Uint8Array",
    "Uint8ClampedArray",
    "Int8Array",
    "Uint16Array",
    "Int16Array",
    "Uint32Array",
    "Int32Array",
    "Float32Array",
    "Float64Array",
  ];
  const ctors = Object.fromEntries(
    typed.map((name) => [name, vm.runInContext(name, ctx) as never]),
  ) as Record<string, new (input: unknown) => unknown>;
  const ArrayBufferCtor = vm.runInContext("ArrayBuffer", ctx) as new (
    length: number,
  ) => ArrayBuffer;
  const tag = (value: object) =>
    Object.prototype.toString.call(value).slice(8, -1);
  const clone = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const t = tag(value);
    if (typed.includes(t)) return new ctors[t](value);
    if (t === "ArrayBuffer") {
      const buffer = value as ArrayBuffer;
      const out = new ArrayBufferCtor(buffer.byteLength);
      new (ctors.Uint8Array as unknown as new (
        out: ArrayBuffer,
      ) => Uint8Array)(out).set(new Uint8Array(buffer));
      return out;
    }
    if (Array.isArray(value)) return value.map(clone);
    if (value instanceof Map) {
      const map = new Map<unknown, unknown>();
      for (const [k, v] of value) map.set(clone(k), clone(v));
      return map;
    }
    if (value instanceof Set) return new Set([...value].map(clone));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  };
  return clone;
}

function webGlobals(): Record<string, unknown> {
  return {
    structuredClone,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    Blob,
    Response,
    Request,
    Headers,
    TextEncoder,
    TextDecoder,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
    crypto,
    DOMException,
    DOMMatrix: DOMMatrixStub,
    ImageData: ImageDataStub,
    Path2D: Path2DStub,
    MessageChannel,
    ReadableStream,
    WritableStream,
    TransformStream,
    CompressionStream,
    DecompressionStream,
    Event,
    EventTarget,
  };
}

// The browser seam, emulated faithfully: the served PDF.js tools bundle runs
// in one realm, and a real Worker boundary loads the served worker asset in
// another. Only the 2D-canvas surface is stubbed.
async function bootBrowser(calls: SeamCalls) {
  const tools = await (await callApp("/pdf-tools.js")).text();

  function fakeCtx(canvas: Record<string, unknown>) {
    return new Proxy(
      { canvas },
      {
        get(target, prop) {
          if (prop in target) return (target as never)[prop as never];
          if (prop === "getTransform") {
            return () => ({
              a: 1,
              b: 0,
              c: 0,
              d: 1,
              e: 0,
              f: 0,
              multiply() {},
            });
          }
          if (prop === "measureText") return () => ({ width: 10 });
          if (
            prop === "createLinearGradient" ||
            prop === "createRadialGradient"
          ) {
            return () => ({ addColorStop() {} });
          }
          if (prop === "createPattern") return () => ({});
          calls.ctxMethods.add(String(prop));
          return () => undefined;
        },
      },
    );
  }

  function makeCanvas() {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => fakeCtx(canvas),
      toBlob: (cb: (blob: Blob | null) => void) =>
        cb(
          new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
            type: "image/png",
          }),
        ),
    };
    calls.canvases++;
    return canvas;
  }

  const location = new URL("https://surveyor.example/corpus");
  const window: Record<string, unknown> = {
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    location,
  };
  const mainSandbox: Record<string, unknown> = {
    ...webGlobals(),
    window,
    document: {
      createElement: (tag: string) => (tag === "canvas" ? makeCanvas() : {}),
    },
    navigator: {
      userAgent: "node",
      platform: "Linux x86_64",
      language: "en-AU",
    },
  };

  // Worker boundary: the main realm calls `new Worker(workerSrc, {type})`
  // and receives a realm running the asset served from that same route.
  class FakeWorker {
    #mainListeners = new Map<unknown, string>();
    #selfListeners = new Map<unknown, string>();
    #self: vm.Context;
    #cloneToMain: (value: unknown) => unknown;
    #cloneToWorker: (value: unknown) => unknown;
    constructor(url: string) {
      calls.workerUrls.push(url);
      const source = workerAssets.get(url);
      if (source === undefined) {
        throw new Error(`no worker asset served for ${url}`);
      }
      const realm = webGlobals();
      vm.createContext(realm);
      realm.onmessage = null;
      realm.postMessage = (data: unknown) => this.#toMain(data);
      realm.addEventListener = (type: string, fn: unknown) => {
        this.#selfListeners.set(fn, type);
      };
      realm.removeEventListener = (fn: unknown) => {
        this.#selfListeners.delete(fn);
      };
      this.#self = realm;
      this.#cloneToWorker = realmCloner(realm);
      this.#cloneToMain = realmCloner(mainSandbox as vm.Context);
      vm.runInContext(source, realm, { filename: url });
    }
    #toMain(data: unknown) {
      const event = { data: this.#cloneToMain(data) };
      queueMicrotask(() => {
        for (const [fn, type] of this.#mainListeners) {
          if (type === "message") (fn as (e: unknown) => void).call(this, event);
        }
      });
    }
    addEventListener(type: string, fn: unknown) {
      this.#mainListeners.set(fn, type);
    }
    removeEventListener(fn: unknown) {
      this.#mainListeners.delete(fn);
    }
    postMessage(data: unknown, _transfers?: unknown) {
      const event = { data: this.#cloneToWorker(data) };
      queueMicrotask(() => {
        for (const [fn, type] of this.#selfListeners) {
          if (type === "message") {
            (fn as (e: unknown) => void).call(this.#self, event);
          }
        }
        (this.#self.onmessage as ((e: unknown) => void) | null)?.(event);
      });
    }
    terminate() {}
  }

  mainSandbox.Worker = FakeWorker;
  vm.createContext(mainSandbox as vm.Context);
  vm.runInContext(tools, mainSandbox as vm.Context, {
    filename: "/pdf-tools.js",
  });
  return window.SurveyorPdf as unknown as BrowserTools;
}

interface BrowserTools {
  extractText: (file: Blob) => Promise<string>;
  rasterise: (file: Blob, maxPages?: number) => Promise<Blob[]>;
  pageCount: (file: Blob) => Promise<number>;
}

async function serveWorkerAssets() {
  workerAssets.clear();
  const res = await callApp("/pdf.worker.mjs");
  expect(res.status, "/pdf.worker.mjs must be served").toBe(200);
  workerAssets.set("/pdf.worker.mjs", await res.text());
}

function emptyCalls(): SeamCalls {
  return { ctxMethods: new Set(), workerUrls: [], canvases: 0 };
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
    const calls = emptyCalls();
    const tools = await bootBrowser(calls);
    const text = await tools.extractText(
      new Blob([makePdf()], { type: "application/pdf" }),
    );
    expect(text).toContain("Hello Surveyor");
    // The worker came from the served asset route, not a CDN or fallback.
    expect(calls.workerUrls).toEqual(["/pdf.worker.mjs"]);
  });

  it("rasterises pages to page images through the browser seam", async () => {
    await serveWorkerAssets();
    const calls = emptyCalls();
    const tools = await bootBrowser(calls);
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
