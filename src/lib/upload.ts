// Forwarding a request body into object storage under workerd's rules.
//
// R2 `put` accepts only a value with a known length: the readable half of a
// `FixedLengthStream`, never a stream derived from a counting transform.
// `storeBody` therefore has two paths:
//
//   - a declared `content-length`: the counted stream is piped through a
//     FixedLengthStream of that length, and its readable half goes to R2 —
//     the bytes stream to object storage without ever sitting in isolate
//     memory, and workerd itself rejects a body that overruns or undershoots
//     the declared length;
//   - no declared length (a chunked client): the counted stream is drained
//     in bounded chunks and the assembled buffer is stored. Memory is still
//     bounded by the cap, and no path calls `arrayBuffer()` on the request.
//
// An over-cap body errors the counter: the streaming path surfaces that
// through the failed put, the buffered path through the read loop. Both
// return with `overCap` set rather than throwing, so routes map their own
// status (413/422) while every other failure stays loud.

export interface StoredBody {
  /** Bytes the counter saw. */
  size: number;
  /** True once the body passed the cap; nothing was stored. */
  overCap: boolean;
  /** Collected bytes when `collect` was asked for and the body stayed under cap. */
  bytes: Uint8Array | null;
  /** True when the bytes reached object storage. */
  stored: boolean;
}

export async function storeBody(
  body: ReadableStream<Uint8Array>,
  opts: {
    cap: number;
    /** Keep the bytes in the result (native text lanes decode in-request). */
    collect?: boolean;
    /** `content-length` when the request declared one, else null. */
    declaredLength: number | null;
    /** Where to store; null drains the body without storing (native text). */
    bucket: R2Bucket | null;
    key: string;
  },
): Promise<StoredBody> {
  const declared = opts.declaredLength;
  const streams =
    opts.bucket !== null && declared !== null && Number.isFinite(declared) && declared >= 0;
  const keepsChunks = Boolean(opts.collect) || (opts.bucket !== null && !streams);
  let size = 0;
  let overCap = false;
  const chunks: Uint8Array[] = [];
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > opts.cap) {
          overCap = true;
          controller.error(new Error("body exceeds the cap"));
          return;
        }
        if (keepsChunks) chunks.push(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  const collected = (): Uint8Array => {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  let stored = false;
  if (streams) {
    const fixed = new FixedLengthStream(declared);
    // The counter may error on an over-cap body; that failure reaches the
    // caller through the put below, so the pipe itself is left unhandled.
    counted.pipeTo(fixed.writable).catch(() => {});
    try {
      await opts.bucket!.put(opts.key, fixed.readable);
      stored = true;
    } catch (err) {
      if (!overCap) throw err;
    }
  } else {
    const reader = counted.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      if (!overCap) throw err;
    }
    if (!overCap && opts.bucket) {
      await opts.bucket.put(opts.key, collected());
      stored = true;
    }
  }

  return {
    size,
    overCap,
    bytes: !overCap && opts.collect ? collected() : null,
    stored,
  };
}
