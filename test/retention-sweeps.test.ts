import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { getState } from "../src/state";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import { unwrap } from "../src/lib/evidence";
import {
  RAW_SWEEP_ACTION,
  SWEEPABLE_CATEGORIES,
  countOverdueRawBytes,
  loadRecentSweeps,
  sweepRawBytes,
  type RawSweepReceipt,
} from "../src/lib/retention";

// D2 (#45): scheduled sweeps cover every sweepable category, deletion
// receipts identify the category and the verification result, and failures
// keep their raw key for the next sweep while staying visible.

const HOUR = 60 * 60 * 1000;
const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    CORPUS: new FakeR2() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function insertSubmission(db: FakeD1) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES ('sub-1', 'h', 'open', 'original', NULL, 0, ?)",
    )
    .bind(ago(2 * HOUR))
    .run();
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

function categorySweep(receipt: RawSweepReceipt, category: string) {
  const found = receipt.categories.find((c) => c.category === category);
  if (!found) throw new Error(`no sweep entry for ${category}`);
  return found;
}

describe("deletion receipts (D2, #45)", () => {
  it("sweeps every catalogue category and reports one entry per category", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db);
    await insertCorpusDoc(db);
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));
    await r2.put("corpus/doc-1", new Uint8Array([2]));

    const receipt = await sweepRawBytes(env, new Date().toISOString());

    expect(receipt.categories.map((c) => c.category)).toEqual(
      SWEEPABLE_CATEGORIES.map((c) => c.id),
    );
    for (const entry of receipt.categories) {
      expect(entry).toMatchObject({
        expired: 1,
        deleted: 1,
        verified: 1,
        unverified: 0,
        failed: 0,
      });
    }
    expect(receipt.totals).toEqual({
      expired: 2,
      deleted: 2,
      verified: 2,
      unverified: 0,
      failed: 0,
    });
    expect(r2.keys()).toEqual([]);
  });

  it("persists the receipt and reads it back over the operator API", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db);
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));

    const receipt = await sweepRawBytes(env, new Date().toISOString());
    const stored = await loadRecentSweeps(db as never, 10);
    expect(stored).toEqual([receipt]);

    const res = await callApp(env, "/api/retention/sweeps", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sweeps: RawSweepReceipt[];
      overdue: Array<{ category: string; overdue: number }>;
    };
    expect(body.sweeps).toEqual([receipt]);
    expect(
      body.sweeps[0].categories.find((c) => c.category === "attachment_raw"),
    ).toMatchObject({ verified: 1, failed: 0 });

    // The receipt names counts and verification only — never keys.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("attachments/sub-1/att-1");
    expect(raw).not.toContain("att-1");

    expect((await callApp(env, "/api/retention/sweeps")).status).toBe(401);
  });

  it("counts an unconfirmed deletion as unverified and keeps it for retry", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db);
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));
    // Delete reports success but the object survives: the sweep must not
    // mark the row expired on the delete call's word alone.
    r2.delete = async () => {};

    const first = await sweepRawBytes(env, new Date().toISOString());
    expect(categorySweep(first, "attachment_raw")).toMatchObject({
      expired: 1,
      deleted: 1,
      verified: 0,
      unverified: 1,
      failed: 1,
    });
    const after = (await db
      .prepare("SELECT status, raw_key FROM attachments WHERE id = 'att-1'")
      .first()) as { status: string; raw_key: string | null };
    expect(after.status).toBe("uploaded");
    expect(after.raw_key).toBe("attachments/sub-1/att-1");

    // Once the object really goes, the next sweep verifies and expires it.
    delete (r2 as { delete?: unknown }).delete;
    const second = await sweepRawBytes(env, new Date().toISOString());
    expect(categorySweep(second, "attachment_raw")).toMatchObject({
      expired: 1,
      deleted: 1,
      verified: 1,
      unverified: 0,
      failed: 0,
    });
    expect(r2.keys()).toEqual([]);
  });

  it("retries a failed delete on the next sweep and keeps it visible meanwhile", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db);
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));
    r2.delete = async () => {
      throw new Error("r2 unavailable");
    };

    const failed = await sweepRawBytes(env, new Date().toISOString());
    expect(categorySweep(failed, "attachment_raw")).toMatchObject({
      expired: 1,
      deleted: 0,
      verified: 0,
      failed: 1,
    });
    const after = (await db
      .prepare("SELECT status, raw_key FROM attachments WHERE id = 'att-1'")
      .first()) as { status: string; raw_key: string | null };
    expect(after.raw_key).toBe("attachments/sub-1/att-1");

    // Between sweeps, the overdue view still shows the bytes that should be
    // gone: a failure does not disappear with the receipt that recorded it.
    delete (r2 as { delete?: unknown }).delete;
    const view = (await (
      await callApp(env, "/api/retention/sweeps", { headers: auth })
    ).json()) as {
      sweeps: RawSweepReceipt[];
      overdue: Array<{ category: string; overdue: number }>;
    };
    expect(view.sweeps[0]).toEqual(failed);
    expect(
      view.overdue.find((o) => o.category === "attachment_raw")?.overdue,
    ).toBe(1);

    const retried = await sweepRawBytes(env, new Date().toISOString());
    expect(categorySweep(retried, "attachment_raw")).toMatchObject({
      deleted: 1,
      verified: 1,
      failed: 0,
    });
    expect(r2.keys()).toEqual([]);
    const overdue = await countOverdueRawBytes(env, new Date().toISOString());
    expect(overdue.find((o) => o.category === "attachment_raw")?.overdue).toBe(0);
  });

  it("shows overdue bytes that no sweep has reached yet", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db);
    // Fresh upload still inside its window: not overdue.
    await insertAttachment(db, {
      id: "att-fresh",
      raw_key: "attachments/sub-1/fresh",
      created_at: ago(HOUR),
    });
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));
    await r2.put("attachments/sub-1/fresh", new Uint8Array([1]));

    const view = (await (
      await callApp(env, "/api/retention/sweeps", { headers: auth })
    ).json()) as {
      sweeps: RawSweepReceipt[];
      overdue: Array<{ category: string; overdue: number }>;
    };
    expect(view.sweeps).toEqual([]);
    expect(
      view.overdue.find((o) => o.category === "attachment_raw")?.overdue,
    ).toBe(1);
  });

  it("runs a sweep on demand so an operator can retry a failure", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await insertAttachment(db);
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));

    expect(
      (await callApp(env, "/api/retention/sweep", { method: "POST" })).status,
    ).toBe(401);

    const res = await callApp(env, "/api/retention/sweep", {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { receipt: RawSweepReceipt };
    expect(
      body.receipt.categories.find((c) => c.category === "attachment_raw"),
    ).toMatchObject({ deleted: 1, verified: 1 });
    expect(r2.keys()).toEqual([]);
    expect(await loadRecentSweeps(db as never, 10)).toHaveLength(1);
  });

  it("persists a readable receipt on the cron entry", async () => {
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

    const stored = await loadRecentSweeps(db as never, 10);
    expect(stored).toHaveLength(1);
    expect(
      stored[0].categories.find((c) => c.category === "attachment_raw"),
    ).toMatchObject({ deleted: 1, verified: 1 });
    const actions = await auditActions(db);
    expect(actions.some((a) => a.startsWith(RAW_SWEEP_ACTION))).toBe(true);
    expect(r2.keys()).toEqual([]);
  });

  it("keeps a receipt even when nothing expired", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    await getState(env as never);

    const receipt = await sweepRawBytes(env, new Date().toISOString());
    expect(receipt.totals).toEqual({
      expired: 0,
      deleted: 0,
      verified: 0,
      unverified: 0,
      failed: 0,
    });
    expect(receipt.categories).toHaveLength(SWEEPABLE_CATEGORIES.length);
    expect(await loadRecentSweeps(db as never, 10)).toEqual([receipt]);
  });
});
