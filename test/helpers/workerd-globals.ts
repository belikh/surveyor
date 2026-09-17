// Node-side shim for the workerd globals the Worker uses at runtime.
// Vitest loads this as a setup file (see vitest.config.ts): the route tests
// exercise the FixedLengthStream path whenever a request declares a
// content-length, so the global must exist before any test runs — and it
// enforces the length exactly as workerd does, so a body that overruns or
// undershoots its declared length fails the same way it would in production.

class FixedLengthStreamShim extends TransformStream<Uint8Array, Uint8Array> {
  readonly expectedLength: number;

  constructor(expectedLength: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expectedLength) {
          controller.error(
            new Error(
              `FixedLengthStream: expected ${expectedLength} bytes, received more`,
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== expectedLength) {
          controller.error(
            new Error(
              `FixedLengthStream: expected ${expectedLength} bytes, received ${seen}`,
            ),
          );
        }
      },
    });
    this.expectedLength = expectedLength;
  }
}

const globals = globalThis as { FixedLengthStream?: unknown };
if (typeof globals.FixedLengthStream === "undefined") {
  globals.FixedLengthStream = FixedLengthStreamShim;
}
