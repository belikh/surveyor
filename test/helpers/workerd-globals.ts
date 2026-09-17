// Node-side shim for the workerd globals the Worker uses at runtime.
// Vitest loads this as a setup file (see vitest.config.ts): the route tests
// exercise the FixedLengthStream path whenever a request declares a
// content-length, so the global must exist before any test runs.

class FixedLengthStreamShim extends TransformStream<Uint8Array, Uint8Array> {
  readonly expectedLength: number;

  constructor(expectedLength: number) {
    super();
    this.expectedLength = expectedLength;
  }
}

const globals = globalThis as { FixedLengthStream?: unknown };
if (typeof globals.FixedLengthStream === "undefined") {
  globals.FixedLengthStream = FixedLengthStreamShim;
}
