// In-process browser seam for the served PDF.js path: the tools bundle runs
// in one VM realm and a real Worker boundary loads the served worker asset in
// another, with only the 2D-canvas surface stubbed. Shared by the A5 route
// test and the A6 headless-browser check's stub driver (A6, #7): the seam is
// the stand-in for a real browser when none is installed, and it exercises
// the exact assets the installation serves.
import vm from "node:vm";

export interface FetchRoute {
  (path: string): Promise<{ status: number; text: string }>;
}

export interface BrowserSeamCalls {
  ctxMethods: Set<string>;
  workerUrls: string[];
  canvases: number;
}

export interface PdfBrowserTools {
  extractText: (file: Blob) => Promise<string>;
  rasterise: (file: Blob, maxPages?: number) => Promise<Blob[]>;
  pageCount: (file: Blob) => Promise<number>;
}

export function emptySeamCalls(): BrowserSeamCalls {
  return { ctxMethods: new Set(), workerUrls: [], canvases: 0 };
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

export interface PdfBrowserSeam {
  /** Fetch a worker asset from the served route and hold it for the
   *  realm boundary. Returns the fetch result so callers can assert it. */
  serveWorkerAsset(
    path?: string,
  ): Promise<{ status: number; text: string }>;
  /** Run the served tools bundle in a fresh realm; the Worker boundary
   *  loads the served worker asset by URL. */
  boot(calls?: BrowserSeamCalls): Promise<PdfBrowserTools>;
}

export function createPdfBrowserSeam(fetchRoute: FetchRoute): PdfBrowserSeam {
  const workerAssets = new Map<string, string>();

  return {
    async serveWorkerAsset(path = "/pdf.worker.mjs") {
      const res = await fetchRoute(path);
      if (res.status === 200) workerAssets.set(path, res.text);
      return res;
    },

    async boot(calls = emptySeamCalls()) {
      const tools = (await fetchRoute("/pdf-tools.js")).text;

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
          createElement: (tag: string) =>
            tag === "canvas" ? makeCanvas() : {},
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
              if (type === "message") {
                (fn as (e: unknown) => void).call(this, event);
              }
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
      return window.SurveyorPdf as unknown as PdfBrowserTools;
    },
  };
}
