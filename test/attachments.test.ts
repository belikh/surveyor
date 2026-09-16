import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import { solveChallenge } from "../src/lib/pow";
import { sealText } from "../src/lib/vault";
import { boot } from "../src/state";
import {
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
  ).json()) as { id: string };
  return created.id;
}

async function upload(
  env: Record<string, unknown>,
  id: string,
  body: string,
  filename = "scan.png",
  mediaType = "image/png",
) {
  return callApp(
    env,
    `/api/intake/${id}/attachments?filename=${encodeURIComponent(filename)}&media_type=${encodeURIComponent(mediaType)}`,
    { method: "POST", headers: { "content-type": mediaType }, body },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitter attachments (R6, FR-045-050)", () => {
  it("streams raw bytes to private R2 and records the upload", async () => {
    const env = makeEnv();
    const id = await createSubmission(env);
    const res = await upload(env, id, "fake-image-bytes");
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

  it("rejects unsupported types and quota-exceeding submissions", async () => {
    const env = makeEnv();
    const id = await createSubmission(env);
    const bad = await upload(env, id, "x", "payload.exe", "application/octet-stream");
    expect(bad.status).toBe(422);

    // Pre-existing usage at the cap: the next upload is refused.
    const { kit } = await boot(env as never);
    await (env.DB as FakeD1)
      .prepare(
        "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, reason, retry_after, created_at) VALUES ('old', ?, ?, 'image/png', ?, 'uploaded', 'k', NULL, NULL, ?)",
      )
      .bind(id, await sealText(kit, "old.png"), ATTACH_TOTAL_BYTES, new Date().toISOString())
      .run();
    const over = await upload(env, id, "tiny");
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error).toBe("quota_exceeded");
  });

  it("OCRs on drain, appends sealed testimony, deletes the raw, and never mirrors", async () => {
    const env = makeEnv({
      AI: { run: async () => ({ answer: "Zara Kline approved the roster" }) },
    });
    const id = await createSubmission(env);
    const up = await upload(env, id, "fake-scan");
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
    const id = await createSubmission(env);
    const up = await upload(env, id, "fake-scan");
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
    const id = await createSubmission(env);
    await upload(env, id, "12345");
    expect(await attachmentBytes(env.DB as never, id)).toBe(5);
  });
});
