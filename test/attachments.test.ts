import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import { solveChallenge } from "../src/lib/pow";
import { sealText, openText } from "../src/lib/vault";
import { boot } from "../src/state";
import {
  ATTACH_MAX_BYTES,
  ATTACH_TOTAL_BYTES,
  drainAttachmentById,
  attachmentBytes,
} from "../src/lib/attachments";

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: new FakeD1() as never,
    CORPUS: new FakeR2() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    POW_DIFFICULTY: "8",
    ...extra,
  };
}

async function callApp(
  env: Record<string, unknown>,
  path: string,
  init?: RequestInit,
) {
  return app.fetch(
    new Request(`https://surveyor.example${path}`, init),
    env as never,
  );
}

async function createSubmission(env: Record<string, unknown>) {
  const ch = (await (
    await callApp(env, "/api/intake/challenge")
  ).json()) as { challenge: string; difficulty: number };
  const nonce = await solveChallenge(ch.challenge, ch.difficulty);
  const created = (await (
    await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ pow: { challenge: ch.challenge, nonce: String(nonce) } }),
    })
  ).json()) as { id: string; access_code: string };
  return { id: created.id, code: created.access_code };
}

async function upload(
  env: Record<string, unknown>,
  id: string,
  code: string,
  body: string,
  filename = "scan.png",
  mediaType = "image/png",
) {
  // The post-A11 transport: identifiers in headers, never the query string.
  return callApp(env, `/api/intake/${id}/attachments`, {
    method: "POST",
    headers: {
      "x-access-code": code,
      "x-filename": encodeURIComponent(filename),
      "content-type": mediaType,
    },
    body,
  });
}

/** Streamed framing: the route must never reach for `arrayBuffer()` — that
 *  is the buffering seam. With `declaredLength` the body takes the workerd
 *  FixedLengthStream path (streamed straight to R2); without one it is a
 *  chunked body, stored as bounded multipart parts (A15 workerd rule). */
async function streamedUpload(
  env: Record<string, unknown>,
  id: string,
  code: string,
  chunks: Uint8Array[],
  filename = "scan.png",
  declaredLength?: number,
) {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  const headers: Record<string, string> = {
    "x-access-code": code,
    "x-filename": encodeURIComponent(filename),
    "content-type": "image/png",
  };
  if (declaredLength !== undefined) {
    headers["content-length"] = String(declaredLength);
  }
  const init = {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit;
  const req = new Request(
    `https://surveyor.example/api/intake/${id}/attachments`,
    init,
  );
  Object.defineProperty(req, "arrayBuffer", {
    value: () => {
      throw new Error("request body was buffered");
    },
  });
  return app.fetch(req, env as never);
}

class RecordingR2 extends FakeR2 {
  streamed: boolean[] = [];
  override async put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  ): Promise<void> {
    this.streamed.push(value instanceof ReadableStream);
    return super.put(key, value);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitter attachments (R6, FR-045-050)", () => {
  it("streams raw bytes to private R2 and records the upload", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const res = await upload(env, id, code, "fake-image-bytes");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("uploaded");
    const r2 = env.CORPUS as FakeR2;
    expect(r2.keys()).toEqual([`attachments/${id}/${body.id}`]);
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status, size_bytes, filename FROM attachments")
      .first()) as { status: string; size_bytes: number; filename: string };
    expect(row.status).toBe("uploaded");
    expect(row.size_bytes).toBe(16);
    // Filename is sealed at rest.
    expect(row.filename.startsWith("v1.")).toBe(true);
  });

  it("stores a chunked body in bounded parts and records the exact size", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const chunks = [
      new TextEncoder().encode("fake-im"),
      new TextEncoder().encode("age-"),
      new TextEncoder().encode("bytes"),
    ];
    const res = await streamedUpload(env, id, code, chunks);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("uploaded");
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT size_bytes FROM attachments WHERE id = ?")
      .bind(body.id)
      .first()) as { size_bytes: number };
    expect(row.size_bytes).toBe(16);
    const stored = await (env.CORPUS as FakeR2).get(
      `attachments/${id}/${body.id}`,
    );
    expect(
      new TextDecoder().decode(await stored!.arrayBuffer()),
    ).toBe("fake-image-bytes");
  });

  it("streams a fifty megabyte upload without buffering the body", async () => {
    const r2 = new RecordingR2();
    const env = makeEnv({ CORPUS: r2 as never });
    const { id, code } = await createSubmission(env);
    const chunks = Array.from({ length: 50 }, () => new Uint8Array(1024 * 1024));
    const res = await streamedUpload(
      env,
      id,
      code,
      chunks,
      "big.bin",
      ATTACH_MAX_BYTES,
    );
    expect(res.status).toBe(201);
    // The object store received a stream, not an arrayBuffer: the 50 MB
    // body never sat in isolate memory.
    expect(r2.streamed).toEqual([true]);
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT size_bytes FROM attachments")
      .first()) as { size_bytes: number };
    expect(row.size_bytes).toBe(ATTACH_MAX_BYTES);
  });

  it("refuses an over-cap streamed body and leaves no object behind", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const chunks = Array.from({ length: 50 }, () => new Uint8Array(1024 * 1024));
    chunks.push(new Uint8Array([1]));
    // The declared length is a lie the FixedLengthStream catches: the body
    // overruns it mid-put and no object survives.
    const res = await streamedUpload(
      env,
      id,
      code,
      chunks,
      "bigger.bin",
      ATTACH_MAX_BYTES,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("too_large");
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
  });

  it("refuses a body that overruns a declared length below the cap", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const chunks = [new TextEncoder().encode("twenty bytes of body")];
    const res = await streamedUpload(env, id, code, chunks, "scan.png", 10);
    expect(res.status).toBe(400);
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
  });

  it("refuses a body that undershoots its declared length, leaving no object", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const chunks = [new TextEncoder().encode("short")];
    const res = await streamedUpload(env, id, code, chunks, "scan.png", 1000);
    expect(res.status).toBe(400);
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
  });

  it("rejects unsupported types and quota-exceeding submissions", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const bad = await upload(env, id, code, "x", "payload.exe", "application/octet-stream");
    expect(bad.status).toBe(422);

    // Pre-existing usage at the cap: the next upload is refused.
    const { kit } = await boot(env as never);
    await (env.DB as FakeD1)
      .prepare(
        "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, reason, retry_after, created_at) VALUES ('old', ?, ?, 'image/png', ?, 'uploaded', 'k', NULL, NULL, ?)",
      )
      .bind(id, await sealText(kit, "old.png"), ATTACH_TOTAL_BYTES, new Date().toISOString())
      .run();
    const over = await upload(env, id, code, "tiny");
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error).toBe("quota_exceeded");
    // The rejected upload deleted the object it streamed.
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
  });

  it("OCRs on drain, appends sealed testimony, deletes the raw, and never mirrors", async () => {
    const env = makeEnv({
      AI: { run: async () => ({ answer: "Zara Kline approved the roster" }) },
    });
    const { id, code } = await createSubmission(env);
    const up = await upload(env, id, code, "fake-scan");
    const attId = ((await up.json()) as { id: string }).id;
    const drained = (await (
      await callApp(env, `/api/intake/${id}/attachments/drain`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number; outcomes: Array<{ status: string }> };
    expect(drained.drained).toBe(1);
    expect(drained.outcomes[0].status).toBe("OCRed");

    const db = env.DB as FakeD1;
    const att = (await db
      .prepare("SELECT status, raw_key FROM attachments WHERE id = ?")
      .bind(attId)
      .first()) as { status: string; raw_key: string | null };
    expect(att.status).toBe("OCRed");
    expect(att.raw_key).toBeNull();
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);

    // Testimony is sealed; the name is quarantined, not stored in the clear.
    const messages = JSON.stringify(await db.prepare("SELECT * FROM messages").all());
    expect(messages).not.toContain("Zara Kline");
    expect(messages).not.toContain("approved the roster");
    const entities = JSON.stringify(await db.prepare("SELECT * FROM entities").all());
    expect(entities).not.toContain("Zara Kline");
    // Testimony only: no corpus mirror write.
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toBe("[]");
  });

  it("keeps the raw sealed for a bounded retry when extraction fails", async () => {
    const env = makeEnv({
      AI: {
        run: async () => {
          throw new Error("neurons exhausted");
        },
      },
    });
    const { id, code } = await createSubmission(env);
    const up = await upload(env, id, code, "fake-scan");
    const attId = ((await up.json()) as { id: string }).id;
    const first = await drainAttachmentById(env as never, attId);
    expect(first.status).toBe("held");
    expect(first.reason).toMatch(/neurons exhausted|no capable/i);

    const r2 = env.CORPUS as FakeR2;
    expect(r2.keys().length).toBe(1);
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT retry_after FROM attachments WHERE id = ?")
      .bind(attId)
      .first()) as { retry_after: string };
    expect(row.retry_after).toBeTruthy();

    // Within the window, the drain refuses rather than retrying.
    const again = await drainAttachmentById(env as never, attId);
    expect(again.reason).toMatch(/retry window/);
  });

  it("counts per-submission usage from the attachments table", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    await upload(env, id, code, "12345");
    expect(await attachmentBytes(env.DB as never, id)).toBe(5);
  });

  it("refuses uploads without the submission's access code", async () => {
    const env = makeEnv();
    const { id } = await createSubmission(env);
    const decoy = await createSubmission(env);
    const missing = await callApp(
      env,
      `/api/intake/${id}/attachments`,
      { method: "POST", headers: { "content-type": "image/png" }, body: "x" },
    );
    expect(missing.status).toBe(404);
    const foreign = await upload(env, id, decoy.code, "x");
    expect(foreign.status).toBe(404);
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
  });

  it("never reads the access code or filename from the query string", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const viaQuery = await callApp(
      env,
      `/api/intake/${id}/attachments?access_code=${encodeURIComponent(code)}&filename=x.png&media_type=image%2Fpng`,
      { method: "POST", headers: { "content-type": "image/png" }, body: "x" },
    );
    expect(viaQuery.status).toBe(404);
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
  });

  it("decodes a percent-encoded filename header and seals it at rest", async () => {
    const env = makeEnv({
      AI: { run: async () => ({ answer: "no names here" }) },
    });
    const { id, code } = await createSubmission(env);
    const res = await upload(
      env,
      id,
      code,
      "fake-scan",
      "employé roster.png",
      "image/png",
    );
    expect(res.status).toBe(201);
    const { kit } = await boot(env as never);
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT filename, lane FROM attachments")
      .first()) as { filename: string; lane: string };
    expect(row.lane).toBe("held-ocr");
    expect(row.filename.startsWith("v1.")).toBe(true);
    expect(await openText(kit, row.filename)).toBe("employé roster.png");
  });

  it("refuses uploads to a closed submission", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    await (env.DB as FakeD1)
      .prepare("UPDATE submissions SET status = 'complete' WHERE id = ?")
      .bind(id)
      .run();
    const closed = await upload(env, id, code, "x");
    expect(closed.status).toBe(409);
  });

  it("serialises concurrent uploads against the per-submission cap", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const { kit } = await boot(env as never);
    // Leave room for exactly two 5-byte uploads.
    await (env.DB as FakeD1)
      .prepare(
        "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, reason, retry_after, created_at) VALUES ('old', ?, ?, 'image/png', ?, 'uploaded', 'k', NULL, NULL, ?)",
      )
      .bind(
        id,
        await sealText(kit, "old.png"),
        ATTACH_TOTAL_BYTES - 10,
        new Date().toISOString(),
      )
      .run();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => upload(env, id, code, "abcde")),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(await attachmentBytes(env.DB as never, id)).toBe(ATTACH_TOTAL_BYTES);
  });
});

describe("attachment lane durability", () => {
  it("drains an attachment whose type came from the filename extension", async () => {
    const env = makeEnv({
      AI: {
        toMarkdown: async () => ({
          format: "markdown",
          data: "Extracted PDF body",
        }),
      },
    });
    const { id, code } = await createSubmission(env);
    const up = await upload(
      env,
      id,
      code,
      "%PDF-1.4 probe",
      "x.pdf",
      "application/octet-stream",
    );
    expect(up.status).toBe(201);
    const attId = ((await up.json()) as { id: string }).id;

    const drained = (await (
      await callApp(env, `/api/intake/${id}/attachments/drain`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number; outcomes: Array<{ status: string }> };
    expect(drained.drained).toBe(1);
    expect(drained.outcomes[0].status).toBe("parsed");

    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status, raw_key FROM attachments WHERE id = ?")
      .bind(attId)
      .first()) as { status: string; raw_key: string | null };
    expect(row.status).toBe("parsed");
    expect(row.raw_key).toBeNull();
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
  });

  it("terminates a row with no lane handler instead of stranding raw bytes", async () => {
    const env = makeEnv();
    const { id } = await createSubmission(env);
    const { kit } = await boot(env as never);
    const attId = "mystery";
    const key = `attachments/${id}/${attId}`;
    await (env.DB as FakeD1)
      .prepare(
        "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, lane, reason, retry_after, created_at) VALUES (?, ?, ?, 'application/octet-stream', 4, 'uploaded', ?, 'held-weird', NULL, NULL, ?)",
      )
      .bind(
        attId,
        id,
        await sealText(kit, "mystery.bin"),
        key,
        new Date().toISOString(),
      )
      .run();
    await (env.CORPUS as FakeR2).put(key, new Uint8Array([1, 2, 3, 4]));

    const out = await drainAttachmentById(env as never, attId);
    expect(out.status).toBe("rejected");
    expect((env.CORPUS as FakeR2).keys()).toEqual([]);
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status, raw_key, reason FROM attachments WHERE id = ?")
      .bind(attId)
      .first()) as { status: string; raw_key: string | null; reason: string | null };
    expect(row.status).toBe("rejected");
    expect(row.raw_key).toBeNull();
    expect(row.reason).toBeTruthy();
  });
});
