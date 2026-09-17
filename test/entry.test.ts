import { describe, it, expect } from "vitest";
import worker, { EngineWorkflow, type EngineParams } from "../src/index";
import { getState } from "../src/state";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import { unwrap } from "../src/lib/evidence";
import type { Bindings, IngestMessage } from "../src/env";

// A9: the Worker entry surface — queue consumer, scheduled() and the
// Workflow entry — exercised in-process with fabricated messages and
// events, the same way workerd drives them.

const TOKEN = "op-token";

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

const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

async function callApp(
  env: Record<string, unknown>,
  path: string,
  init?: RequestInit,
) {
  return worker.fetch(
    new Request(`https://survey.example${path}`, init),
    env as never,
  );
}

/** A fabricated queue batch: records what the consumer did with each message. */
function fabricateBatch(bodies: IngestMessage[]) {
  const calls = { ack: 0, retry: 0 };
  const batch = {
    queue: "surveyor-ingest",
    messages: bodies.map((body) => ({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {
        calls.ack++;
      },
      retry: () => {
        calls.retry++;
      },
    })),
  };
  return { batch, calls };
}

async function seedHeldCorpusDoc(env: Record<string, unknown>) {
  const db = env.DB as FakeD1;
  const r2 = env.CORPUS as FakeR2;
  await getState(env as never);
  const id = crypto.randomUUID();
  const key = `corpus/${id}`;
  await db
    .prepare(
      "INSERT INTO corpus_docs (id, filename, lane, status, verdict, text_envelope, raw_key, reason, created_at) VALUES (?, ?, 'held-ocr', 'held', 'pending', 'v1.x.y', ?, NULL, ?)",
    )
    .bind(id, "v1.sealed", key, new Date().toISOString())
    .run();
  await r2.put(key, new Uint8Array([1, 2, 3]));
  return { id, key };
}

async function seedHeldAttachment(env: Record<string, unknown>) {
  const db = env.DB as FakeD1;
  const r2 = env.CORPUS as FakeR2;
  await getState(env as never);
  await db
    .prepare(
      "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES ('sub-1', 'h', 'open', 'original', NULL, 0, ?)",
    )
    .bind(new Date().toISOString())
    .run();
  const id = crypto.randomUUID();
  const key = `attachments/sub-1/${id}`;
  await db
    .prepare(
      "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, lane, reason, retry_after, created_at) VALUES (?, 'sub-1', 'v1.sealed', 'image/png', 3, 'uploaded', ?, 'held-ocr', NULL, NULL, ?)",
    )
    .bind(id, key, new Date().toISOString())
    .run();
  await r2.put(key, new Uint8Array([1, 2, 3]));
  return { id, key };
}

describe("queue consumer entry", () => {
  it("acks a corpus message and drains the held doc", async () => {
    const env = makeEnv({
      AI: { run: async () => ({ answer: "Transcribed roster text" }) },
    });
    const { id, key } = await seedHeldCorpusDoc(env);
    const { batch, calls } = fabricateBatch([{ doc_id: id, lane: "held-ocr" }]);

    await worker.queue(batch as never, env as never, {} as never);

    expect(calls).toEqual({ ack: 1, retry: 0 });
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status, raw_key FROM corpus_docs WHERE id = ?")
      .bind(id)
      .first()) as { status: string; raw_key: string | null };
    expect(row.status).toBe("OCRed");
    expect(row.raw_key).toBeNull();
    expect((env.CORPUS as FakeR2).has(key)).toBe(false);
    const tele = JSON.stringify(await (env.DB as FakeD1).prepare("SELECT * FROM telemetry").all());
    expect(tele).toContain("OCRed");
  });

  it("acks an attachment message and appends sealed testimony", async () => {
    const env = makeEnv({
      AI: { run: async () => ({ answer: "Zara Kline approved the roster" }) },
    });
    const { id, key } = await seedHeldAttachment(env);
    const { batch, calls } = fabricateBatch([
      { doc_id: id, lane: "attachment", kind: "attachment" },
    ]);

    await worker.queue(batch as never, env as never, {} as never);

    expect(calls).toEqual({ ack: 1, retry: 0 });
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status, raw_key FROM attachments WHERE id = ?")
      .bind(id)
      .first()) as { status: string; raw_key: string | null };
    expect(row.status).toBe("OCRed");
    expect(row.raw_key).toBeNull();
    expect((env.CORPUS as FakeR2).has(key)).toBe(false);
    // Testimony is sealed, and the name is quarantined rather than stored raw.
    const messages = JSON.stringify(await (env.DB as FakeD1).prepare("SELECT * FROM messages").all());
    expect(messages).not.toContain("Zara Kline");
    expect(messages).not.toContain("approved the roster");
  });

  it("acks a held drain that found no capable provider, rather than retrying forever", async () => {
    const env = makeEnv();
    const { id, key } = await seedHeldCorpusDoc(env);
    const { batch, calls } = fabricateBatch([{ doc_id: id, lane: "held-ocr" }]);

    await worker.queue(batch as never, env as never, {} as never);

    // The message is done: the file is durable in D1 + R2 and the operator
    // can drain it later. Retrying would just burn queue attempts.
    expect(calls).toEqual({ ack: 1, retry: 0 });
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status, reason FROM corpus_docs WHERE id = ?")
      .bind(id)
      .first()) as { status: string; reason: string | null };
    expect(row.status).toBe("held");
    expect(row.reason).toMatch(/vision-capable/i);
    expect((env.CORPUS as FakeR2).has(key)).toBe(true);
  });

  it("retries the message when the drain throws", async () => {
    const env = makeEnv();
    const { id, key } = await seedHeldAttachment(env);
    (env.CORPUS as FakeR2).get = async () => {
      throw new Error("r2 unavailable");
    };
    const { batch, calls } = fabricateBatch([
      { doc_id: id, lane: "attachment", kind: "attachment" },
    ]);

    await worker.queue(batch as never, env as never, {} as never);

    expect(calls).toEqual({ ack: 0, retry: 1 });
    // Nothing was sealed or deleted: the next attempt owns the same bytes.
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status, raw_key FROM attachments WHERE id = ?")
      .bind(id)
      .first()) as { status: string; raw_key: string | null };
    expect(row.status).toBe("uploaded");
    expect(row.raw_key).toBe(key);
  });
});

describe("scheduled entry", () => {
  function corpusHeaders(filename: string, mediaType: string): Record<string, string> {
    return {
      authorization: `Bearer ${TOKEN}`,
      "x-filename": encodeURIComponent(filename),
      "content-type": mediaType,
    };
  }

  async function seedPublished(env: Record<string, unknown>, type: string) {
    await callApp(env, "/api/corpus", {
      method: "POST",
      headers: corpusHeaders("notes.txt", "text/plain"),
      body: "Rosters run late on Tuesdays",
    });
    const proposed = (await (
      await callApp(env, "/api/engine/angles/propose", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ topics: ["roster"] }),
      })
    ).json()) as { angles: Array<{ id: string }> };
    await callApp(env, `/api/engine/angles/${proposed.angles[0].id}/approve`, {
      method: "POST",
      headers: auth,
    });
    const line = (await (
      await callApp(env, "/api/engine/lines", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          angle_id: proposed.angles[0].id,
          spend_cap: 100,
        }),
      })
    ).json()) as { id: string };
    const docs = (await (
      await callApp(env, "/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ id: string }> };
    await callApp(env, `/api/engine/lines/${line.id}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        citations: [{ doc_id: docs.docs[0].id, snippet: "late" }],
        findings: "Rosters run late",
      }),
    });
    await callApp(env, `/api/reports/${type}/approve`, {
      method: "POST",
      headers: auth,
    });
    await recordLegal(env, type);
    await callApp(env, `/api/reports/${type}/publish`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
  }

  // D7's legal gate releases one version at a time, so each auto-render needs
  // a fresh record for the version it will produce.
  async function recordLegal(env: Record<string, unknown>, type: string) {
    await callApp(env, `/api/reports/${type}/legal`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        reviewer: "A. Lawyer",
        notes: "Defamation and public-interest check complete",
      }),
    });
    await callApp(env, `/api/reports/${type}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        subject: "Example Pty Ltd",
        channel: "email",
        outcome: "no_response",
      }),
    });
  }

  it("evaluates due reports through the scheduled handler", async () => {
    const env = makeEnv();
    await seedPublished(env, "briefing");
    await callApp(env, "/api/reports/briefing/config", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ config: { cadence_ms: 1 } }),
    });
    await recordLegal(env, "briefing");

    await worker.scheduled(
      {} as ScheduledEvent,
      env as never,
      {} as ExecutionContext,
    );

    const receipts = unwrap(
      await (env.DB as FakeD1)
        .prepare("SELECT type, action, reason FROM eval_receipts")
        .bind()
        .all<{ type: string; action: string; reason: string }>(),
    );
    const briefing = receipts.find((r) => r.type === "briefing");
    expect(briefing?.action).toBe("rendered");
    expect(briefing?.reason).toMatch(/cadence/i);
    const read = (await (
      await callApp(env, "/api/reports/briefing")
    ).json()) as Record<string, unknown>;
    expect(read.version).toBe(2);
  });

  it("sweeps raw bytes before evaluating, so no render reads expired material", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    await getState(env as never);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db
      .prepare(
        "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES ('sub-old', 'h', 'open', 'original', NULL, 0, ?)",
      )
      .bind(old)
      .run();
    await db
      .prepare(
        "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, lane, reason, retry_after, created_at) VALUES ('att-old', 'sub-old', 'v1.sealed', 'image/png', 1, 'uploaded', 'attachments/sub-old/att-old', 'held-ocr', NULL, NULL, ?)",
      )
      .bind(old)
      .run();
    const r2 = env.CORPUS as FakeR2;
    await r2.put("attachments/sub-old/att-old", new Uint8Array([1]));

    await worker.scheduled(
      {} as ScheduledEvent,
      env as never,
      {} as ExecutionContext,
    );

    expect(r2.keys()).toEqual([]);
    const row = (await db
      .prepare("SELECT status FROM attachments WHERE id = 'att-old'")
      .first()) as { status: string };
    expect(row.status).toBe("expired");
  });
});

describe("Workflow entry", () => {
  it("runs its steps in order and records each effect once under resume", async () => {
    const env = makeEnv();
    await getState(env as never);
    await (env.DB as FakeD1)
      .prepare(
        "INSERT INTO reports (type, config_json, status, enabled, current_version, sched_last_count, sched_total, approved_at, updated_at) VALUES ('briefing', '{}', 'draft', 1, 0, 0, 0, NULL, ?)",
      )
      .bind(new Date().toISOString())
      .run();

    const wf = new EngineWorkflow(
      {} as ExecutionContext,
      env as never as Bindings,
    );
    // workerd's workflow step engine memoises by step name: re-entry after
    // an interruption replays no completed step. Model that here with a memo
    // that survives the second run, as the real engine's storage does.
    const memo = new Map<string, unknown>();
    const names: string[] = [];
    const step = {
      do: async (name: string, cb: () => Promise<unknown>) => {
        names.push(name);
        if (!memo.has(name)) memo.set(name, await cb());
        return memo.get(name);
      },
    };
    const payload: EngineParams = { line_id: "line-1", angle_id: "angle-1" };
    const run = () => wf.run({ payload } as never, step as never);

    await run();
    expect(names).toEqual([
      "record-line-opened",
      "evaluate-report-frequencies",
    ]);
    const wfTurns = unwrap(
      await (env.DB as FakeD1)
        .prepare("SELECT tier, label, outcome FROM telemetry WHERE tier = 'workflow'")
        .bind()
        .all<{ tier: string; label: string; outcome: string }>(),
    );
    expect(wfTurns).toHaveLength(1);
    expect(wfTurns[0].label).toBe("line:angle-1");
    expect(wfTurns[0].outcome).toBe("opened");
    const receipts = unwrap(
      await (env.DB as FakeD1)
        .prepare("SELECT type, action FROM eval_receipts")
        .bind()
        .all<{ type: string; action: string }>(),
    );
    expect(receipts).toEqual([{ type: "briefing", action: "skipped" }]);

    // Resume: the same instance enters the same steps, and memoised work is
    // not repeated — no second telemetry turn, no second receipt.
    await run();
    expect(names).toEqual([
      "record-line-opened",
      "evaluate-report-frequencies",
      "record-line-opened",
      "evaluate-report-frequencies",
    ]);
    const after = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM telemetry WHERE tier = 'workflow'")
      .first<{ n: number }>();
    expect(after?.n).toBe(1);
    const afterReceipts = await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM eval_receipts")
      .first<{ n: number }>();
    expect(afterReceipts?.n).toBe(1);
  });
});
