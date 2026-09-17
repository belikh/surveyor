// Forwarding a request body into object storage under workerd's rules.
//
// R2 `put` accepts only a value with a known length — a request body or the
// readable half of a `FixedLengthStream` — never a counting transform's
// output. `storeBody` therefore has three paths:
//
//   - a valid declared `content-length`: the counted stream is piped through
//     a FixedLengthStream of that length and its readable half goes to R2.
//     The bytes stream to object storage without sitting in isolate memory,
//     and workerd rejects a body that overruns or undershoots the declared
//     length;
//   - no declared length (a chunked client): a multipart upload in bounded
//     parts of PART_BYTES, so at most one part sits in isolate memory
//     whatever the body length;
//   - no bucket (native text lanes decode in-request): the body is drained
//     and, when asked, collected whole — those lanes mirror the text anyway.
//
// An over-cap body errors the counter: the streaming path surfaces that
// through the failed put, the multipart path through the read loop. Both
// return with `overCap` set rather than throwing, so routes map their own
// status (413/422) while every other failure stays loud. A declared length
// above the cap is rejected before the body is read at all.

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

/** Multipart part size: bound on the isolate memory an unknown-length body uses. */
export const PART_BYTES = 8 * 1024 * 1024;

function parseDeclaredLength(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const length = Number(header);
  return Number.isInteger(length) && length >= 0 ? length : null;
}

export async function storeBody(
  body: ReadableStream<Uint8Array>,
  opts: {
    cap: number;
    /** Keep the bytes in the result (native text lanes decode in-request). */
    collect?: boolean;
    /** The raw `content-length` header; parsed and validated here. */
    declaredLengthHeader: string | null;
    /** Where to store; null drains the body without storing (native text). */
    bucket: R2Bucket | null;
    key: string;
  },
): Promise<StoredBody> {
  const declared = parseDeclaredLength(opts.declaredLengthHeader);
  if (declared !== null && declared > opts.cap) {
    return { size: 0, overCap: true, bytes: null, stored: false };
  }

  const collect = Boolean(opts.collect);
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
        if (collect) chunks.push(chunk);
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
  if (opts.bucket && declared !== null) {
    const fixed = new FixedLengthStream(declared);
    // The counter may error on an over-cap body; that failure reaches the
    // caller through the put below, so the pipe itself is left unhandled
    // here and awaited after.
    const piped = counted.pipeTo(fixed.writable).catch(() => {});
    try {
      await opts.bucket.put(opts.key, fixed.readable);
      stored = true;
    } catch (err) {
      // Unblock the pipe so the request body is released, never left locked.
      await fixed.readable.cancel().catch(() => {});
      if (!overCap) throw err;
    }
    await piped;
  } else if (opts.bucket) {
    stored = await storeMultipart(opts.bucket, opts.key, counted, () => overCap);
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
  }

  return {
    size,
    overCap,
    bytes: collect && !overCap ? collected() : null,
    stored,
  };
}

/**
 * Store an unknown-length body as a multipart upload: each part is at most
 * PART_BYTES, so isolate memory is bounded by one part rather than the body.
 * An over-cap body errors the counter, the read loop aborts the upload, and
 * no object ever becomes visible; every other failure stays loud.
 */
async function storeMultipart(
  bucket: R2Bucket,
  key: string,
  counted: ReadableStream<Uint8Array>,
  isOverCap: () => boolean,
): Promise<boolean> {
  const reader = counted.getReader();
  const upload = await bucket.createMultipartUpload(key);
  let part = new Uint8Array(PART_BYTES);
  let held = 0;
  const parts: R2UploadedPart[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(PART_BYTES - held, value.byteLength - offset);
        part.set(value.subarray(offset, offset + take), held);
        held += take;
        offset += take;
        if (held === PART_BYTES) {
          parts.push(await upload.uploadPart(parts.length + 1, part));
          part = new Uint8Array(PART_BYTES);
          held = 0;
        }
      }
    }
    if (held === 0 && parts.length === 0) {
      // Empty body: no part worth completing, and the route rejects it.
      await upload.abort();
      return false;
    }
    if (held > 0) {
      parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, held)));
    }
    await upload.complete(parts);
    return true;
  } catch (err) {
    // Release the unread remainder too, so the request body is never left
    // locked by a failed part upload.
    await reader.cancel().catch(() => {});
    await upload.abort().catch(() => {});
    if (isOverCap()) return false;
    throw err;
  }
}
