// Minimal in-memory R2 facade for route tests. Accepts the shapes the
// Worker passes: Uint8Array (direct puts) and ReadableStream (streamed
// uploads, e.g. submitter attachments).
export class FakeR2 {
  private store = new Map<string, Uint8Array>();

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  ): Promise<void> {
    if (value instanceof Uint8Array) {
      this.store.set(key, new Uint8Array(value));
      return;
    }
    if (value instanceof ArrayBuffer) {
      this.store.set(key, new Uint8Array(value));
      return;
    }
    const chunks: Uint8Array[] = [];
    const reader = value.getReader();
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) chunks.push(chunk);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    this.store.set(key, out);
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const v = this.store.get(key);
    if (!v) return null;
    return {
      arrayBuffer: async () =>
        v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}
