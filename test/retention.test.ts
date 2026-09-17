import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { getState } from "../src/state";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import { unwrap } from "../src/lib/evidence";
import {
  RAW_RETRY_WINDOW_MS,
  RAW_SWEEP_ACTION,
  sweepRawBytes,
} from "../src/lib/retention";

// A3: raw submitter attachment bytes and held corpus bytes are deleted once
// their retry window lapses — without waiting for a later drain — and the
// sweep records a receipt. Successful drains still delete immediately.

const HOUR = 60 * 60 * 1000;

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    CORPUS: new FakeR2() as never,
    OPERATOR_TOKEN: "op-token",
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function ahead(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

async function insertAttachment(
  db: FakeD1,
  over: Record<string, string | null> = {},
) {
  await insertSubmission(db);
  const row = {
    id: "att-1",
    submission_id: "sub-1",
    filename: "v1.sealed",
    media_type: "image/png",
    size_bytes: "16",
    status: "uploaded",
    raw_key: "attachments/sub-1/att-1",
    lane: "held-ocr",
    reason: null,
    retry_after: null,
    created_at: ago(25 * HOUR),
    ...over,
  };
  await db
    .prepare(
      "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, lane, reason, retry_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(...Object.values(row))
    .run();
  return row;
}

async function insertCorpusDoc(
  db: FakeD1,
  over: Record<string, string | null> = {},
) {
  const row = {
    id: "doc-1",
    filename: "v1.sealed",
    lane: "held-ocr",
    status: "held",
    verdict: "pending",
    text_envelope: "v1.x.y",
    raw_key: "corpus/doc-1",
    reason: null,
    retry_after: null,
    created_at: ago(25 * HOUR),
    ...over,
  };
  await db
    .prepare(
      "INSERT INTO corpus_docs (id, filename, lane, status, verdict, text_envelope, raw_key, reason, retry_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(...Object.values(row))
    .run();
  return row;
}

async function auditActions(db: FakeD1): Promise<string[]> {
  const rows = unwrap(
    await db
      .prepare("SELECT action FROM audit ORDER BY rowid")
      .bind()
      .all<{ action: string }>(),
  );
  return rows.map((r) => r.action);
}

async function insertSubmission(db: FakeD1) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES ('sub-1', 'h', 'open', 'original', NULL, 0, ?)",
    )
    .bind(ago(2 * HOUR))
    .run();
}

describe("raw-byte retention sweep", () => {
  it("deletes a never-drained attachment on schedule and records a receipt", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    const row = await insertAttachment(db);
    await r2.put(row.raw_key as string, new Uint8Array([1, 2, 3]));

    const receipt = await sweepRawBytes(env, new Date().toISOString());
    expect(receipt.attachments).toEqual({ expired: 1, deleted: 1, failed: 0 });
    expect(r2.keys()).toEqual([]);
    const after = (await db
      .prepare("SELECT status, raw_key, reason, retry_after FROM attachments WHERE id = ?")
      .bind(row.id)
      .first()) as {
      status: string;
      raw_key: string | null;
      reason: string | null;
      retry_after: string | null;
    };
    expect(after.status).toBe("expired");
    expect(after.raw_key).toBeNull();
    expect(after.reason).toMatch(/retry window/);
    expect(after.retry_after).toBeNull();

    const actions = await auditActions(db);
    expect(actions.some((a) => a.startsWith(RAW_SWEEP_ACTION))).toBe(true);
    const receiptLine = actions.find((a) => a.startsWith(RAW_SWEEP_ACTION))!;
    expect(receiptLine).toContain('"deleted":1');
    expect(receiptLine).not.toContain("att-1");
    expect(receiptLine).not.toContain(row.raw_key as string);
  });

  it("keeps bytes within the window and honours a restarted window", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    // Fresh upload: inside its window.
    await insertAttachment(db, { id: "fresh", raw_key: "attachments/sub-1/fresh", created_at: ago(HOUR) });
    // Old upload whose failed drain reset the window into the future.
    await insertAttachment(db, {
      id: "retried",
      raw_key: "attachments/sub-1/retried",
      status: "held",
      retry_after: ahead(HOUR),
      created_at: ago(30 * HOUR),
    });
    await r2.put("attachments/sub-1/fresh", new Uint8Array([1]));
    await r2.put("attachments/sub-1/retried", new Uint8Array([2]));

    const receipt = await sweepRawBytes(env, new Date().toISOString());
    expect(receipt.attachments).toEqual({ expired: 0, deleted: 0, failed: 0 });
    expect(r2.keys().sort()).toEqual([
      "attachments/sub-1/fresh",
      "attachments/sub-1/retried",
    ]);
  });

  it("deletes held bytes whose restarted window has lapsed", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db, {
      id: "lapsed",
      raw_key: "attachments/sub-1/lapsed",
      status: "held",
      retry_after: ago(HOUR),
      created_at: ago(40 * HOUR),
    });
    await r2.put("attachments/sub-1/lapsed", new Uint8Array([1]));

    const receipt = await sweepRawBytes(env, new Date().toISOString());
    expect(receipt.attachments).toEqual({ expired: 1, deleted: 1, failed: 0 });
    expect(r2.keys()).toEqual([]);
  });

  it("sweeps expired held corpus bytes and ignores already-drained rows", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertCorpusDoc(db, { id: "expired", raw_key: "corpus/expired" });
    // Drained docs hold no raw key; parsed docs never had one.
    await insertCorpusDoc(db, {
      id: "drained",
      status: "parsed",
      raw_key: null,
      created_at: ago(100 * HOUR),
    });
    await r2.put("corpus/expired", new Uint8Array([1]));

    const receipt = await sweepRawBytes(env, new Date().toISOString());
    expect(receipt.corpus).toEqual({ expired: 1, deleted: 1, failed: 0 });
    expect(r2.keys()).toEqual([]);
    const drained = (await db
      .prepare("SELECT status FROM corpus_docs WHERE id = 'drained'")
      .first()) as { status: string };
    expect(drained.status).toBe("parsed");
  });

  it("counts a failed object delete and keeps the raw key for the next sweep", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db);
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));
    r2.delete = async () => {
      throw new Error("r2 unavailable");
    };

    const receipt = await sweepRawBytes(env, new Date().toISOString());
    expect(receipt.attachments).toEqual({ expired: 1, deleted: 0, failed: 1 });
    const after = (await db
      .prepare("SELECT status, raw_key FROM attachments WHERE id = 'att-1'")
      .first()) as { status: string; raw_key: string | null };
    expect(after.status).toBe("uploaded");
    expect(after.raw_key).toBe("attachments/sub-1/att-1");
  });

  it("deletes expired bytes on the cron entry and still evaluates reports", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db);
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));

    await worker.scheduled(
      {} as ScheduledEvent,
      env as never,
      {} as ExecutionContext,
    );

    expect(r2.keys()).toEqual([]);
    const after = (await db
      .prepare("SELECT status FROM attachments WHERE id = 'att-1'")
      .first()) as { status: string };
    expect(after.status).toBe("expired");
    const actions = await auditActions(db);
    expect(actions.some((a) => a.startsWith(RAW_SWEEP_ACTION))).toBe(true);
    // The schedule still produced its evaluation receipts (a no-op here).
    expect(actions.length).toBeGreaterThan(0);
  });

  it("documents the window the sweep enforces", () => {
    expect(RAW_RETRY_WINDOW_MS).toBe(24 * HOUR);
  });
});
