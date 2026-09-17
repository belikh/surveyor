import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { getState } from "../src/state";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import { unwrap } from "../src/lib/evidence";
import {
  DEFAULT_RETENTION_WINDOWS,
  MAX_RETENTION_MS,
  MIN_RETENTION_MS,
  RAW_RETRY_WINDOW_MS,
  RAW_SWEEP_ACTION,
  RETAINED_CATEGORIES,
  SWEEPABLE_CATEGORIES,
  loadRetentionWindows,
  saveRetentionWindows,
  sweepRawBytes,
  validateRetentionWindows,
  type CategorySweep,
  type RawSweepReceipt,
} from "../src/lib/retention";

// A3: raw submitter attachment bytes and held corpus bytes are deleted once
// their retry window lapses — without waiting for a later drain — and the
// sweep records a receipt. Successful drains still delete immediately.
//
// D1 (#44): retention is modelled per data category with configurable
// windows and safe defaults; unsupported configurations are refused with
// reasons.

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

function categorySweep(
  receipt: RawSweepReceipt,
  category: string,
): CategorySweep {
  const found = receipt.categories.find((c) => c.category === category);
  if (!found) throw new Error(`no sweep entry for ${category}`);
  return found;
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
    expect(categorySweep(receipt, "attachment_raw")).toMatchObject({ expired: 1, deleted: 1, verified: 1, failed: 0 });
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
    expect(after.reason).toMatch(/retention window/);
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
    expect(categorySweep(receipt, "attachment_raw")).toMatchObject({ expired: 0, deleted: 0, verified: 0, failed: 0 });
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
    expect(categorySweep(receipt, "attachment_raw")).toMatchObject({ expired: 1, deleted: 1, verified: 1, failed: 0 });
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
    expect(categorySweep(receipt, "corpus_raw")).toMatchObject({ expired: 1, deleted: 1, verified: 1, failed: 0 });
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
    expect(categorySweep(receipt, "attachment_raw")).toMatchObject({ expired: 1, deleted: 0, verified: 0, failed: 1 });
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

// D1 (#44): per-category windows, safe defaults, refusals with reasons.

const TOKEN = "op-token";
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

async function putWindows(
  env: Record<string, unknown>,
  windows: Record<string, number>,
) {
  const res = await callApp(env, "/api/retention", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ windows }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("retention categories and configurable windows (D1, #44)", () => {
  it("applies the safe defaults with nothing configured", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    expect(await loadRetentionWindows(db as never)).toEqual(
      DEFAULT_RETENTION_WINDOWS,
    );
    expect(DEFAULT_RETENTION_WINDOWS.attachment_raw).toBe(24 * HOUR);
    expect(DEFAULT_RETENTION_WINDOWS.corpus_raw).toBe(24 * HOUR);
    // The safe default is the promise the docs already make: 24 h, not
    // "hold forever" and not "delete the moment a queue retries".
    await insertAttachment(db, { created_at: ago(25 * HOUR) });
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));
    const receipt = await sweepRawBytes(env, new Date().toISOString());
    expect(categorySweep(receipt, "attachment_raw")).toMatchObject({ expired: 1, deleted: 1, verified: 1, failed: 0 });
    expect(receipt.windows_ms).toEqual(DEFAULT_RETENTION_WINDOWS);
  });

  it("honours a configured window per category", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    const saved = await saveRetentionWindows(
      db as never,
      { attachment_raw: 48, corpus_raw: 2 },
      new Date().toISOString(),
    );
    expect(saved.ok).toBe(true);

    await insertAttachment(db, {
      id: "inside",
      raw_key: "attachments/sub-1/inside",
      created_at: ago(25 * HOUR),
    });
    await insertAttachment(db, {
      id: "outside",
      raw_key: "attachments/sub-1/outside",
      created_at: ago(49 * HOUR),
    });
    await insertCorpusDoc(db, {
      id: "corpus-inside",
      raw_key: "corpus/inside",
      created_at: ago(HOUR),
    });
    await insertCorpusDoc(db, {
      id: "corpus-outside",
      raw_key: "corpus/outside",
      created_at: ago(3 * HOUR),
    });
    for (const key of [
      "attachments/sub-1/inside",
      "attachments/sub-1/outside",
      "corpus/inside",
      "corpus/outside",
    ]) {
      await r2.put(key, new Uint8Array([1]));
    }

    const receipt = await sweepRawBytes(env, new Date().toISOString());
    expect(categorySweep(receipt, "attachment_raw")).toMatchObject({ expired: 1, deleted: 1, verified: 1, failed: 0 });
    expect(categorySweep(receipt, "corpus_raw")).toMatchObject({ expired: 1, deleted: 1, verified: 1, failed: 0 });
    expect(r2.keys().sort()).toEqual([
      "attachments/sub-1/inside",
      "corpus/inside",
    ]);
    expect(receipt.windows_ms.attachment_raw).toBe(48 * HOUR);
    expect(receipt.windows_ms.corpus_raw).toBe(2 * HOUR);
  });

  it("refuses a window for a retained category and says why", () => {
    for (const category of RETAINED_CATEGORIES) {
      const refused = validateRetentionWindows({ [category.id]: 24 });
      expect(refused.ok, category.id).toBe(false);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.refusals).toHaveLength(1);
      expect(refused.refusals[0].category).toBe(category.id);
      expect(refused.refusals[0].reason).toContain(category.label);
      expect(refused.refusals[0].reason).toMatch(/retained/i);
    }
  });

  it("refuses unknown categories, fractional hours and out-of-bounds windows", () => {
    const unknown = validateRetentionWindows({ nonsense: 24 });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("unreachable");
    expect(unknown.refusals[0].reason).toContain("unknown retention category");

    const fractional = validateRetentionWindows({ attachment_raw: 1.5 });
    expect(fractional.ok).toBe(false);
    if (fractional.ok) throw new Error("unreachable");
    expect(fractional.refusals[0].reason).toContain("whole number of hours");

    const below = validateRetentionWindows({
      attachment_raw: MIN_RETENTION_MS / HOUR - 1,
    });
    expect(below.ok).toBe(false);
    if (below.ok) throw new Error("unreachable");
    expect(below.refusals[0].reason).toContain("minimum");

    const above = validateRetentionWindows({
      attachment_raw: MAX_RETENTION_MS / HOUR + 1,
    });
    expect(above.ok).toBe(false);
    if (above.ok) throw new Error("unreachable");
    expect(above.refusals[0].reason).toContain("maximum");

    const notAMap = validateRetentionWindows(24);
    expect(notAMap.ok).toBe(false);

    // Every refusal names the category it is about, and a valid update
    // returns the bound windows in milliseconds.
    const good = validateRetentionWindows({ attachment_raw: 12 });
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error("unreachable");
    expect(good.windows).toEqual({ attachment_raw: 12 * HOUR });
  });

  it("keeps a coherent catalogue with defaults inside each category's bounds", () => {
    const sweepables = SWEEPABLE_CATEGORIES.map((c) => c.id);
    expect(sweepables).toEqual(["attachment_raw", "corpus_raw"]);
    for (const category of SWEEPABLE_CATEGORIES) {
      expect(category.default_ms).toBeGreaterThanOrEqual(category.min_ms);
      expect(category.default_ms).toBeLessThanOrEqual(category.max_ms);
      expect(category.min_ms).toBeGreaterThan(0);
    }
  });

  it("falls back to the safe defaults when the stored configuration is unreadable", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    await getState(env as never);
    await db
      .prepare(
        "INSERT INTO retention_config (id, config_json, updated_at) VALUES (1, ?, ?)",
      )
      .bind("{not json", new Date().toISOString())
      .run();
    expect(await loadRetentionWindows(db as never)).toEqual(
      DEFAULT_RETENTION_WINDOWS,
    );

    // A stored value that is not a positive number is ignored per entry.
    await db
      .prepare(
        "UPDATE retention_config SET config_json = ? WHERE id = 1",
      )
      .bind(JSON.stringify({ windows: { attachment_raw: -5, corpus_raw: 7200000 } }))
      .run();
    const windows = await loadRetentionWindows(db as never);
    expect(windows.attachment_raw).toBe(DEFAULT_RETENTION_WINDOWS.attachment_raw);
    expect(windows.corpus_raw).toBe(2 * HOUR);
  });

  it("exposes, updates and persists windows over the operator API", async () => {
    const env = makeEnv();
    await getState(env as never);

    expect((await callApp(env, "/api/retention")).status).toBe(401);

    const view = await callApp(env, "/api/retention", { headers: auth });
    expect(view.status).toBe(200);
    const catalogue = (await view.json()) as {
      window_unit: string;
      windows_hours: Record<string, number>;
      defaults_hours: Record<string, number>;
      categories: Array<{ id: string; default_ms: number }>;
      retained: Array<{ id: string; why: string }>;
    };
    expect(catalogue.window_unit).toBe("hours");
    expect(catalogue.windows_hours).toEqual({ attachment_raw: 24, corpus_raw: 24 });
    expect(catalogue.defaults_hours).toEqual({
      attachment_raw: 24,
      corpus_raw: 24,
    });
    expect(catalogue.categories.map((c) => c.id)).toEqual([
      "attachment_raw",
      "corpus_raw",
    ]);
    expect(catalogue.retained.map((c) => c.id)).toEqual([
      "sealed_evidence",
      "published_versions",
      "audit_receipts",
    ]);

    const put = await putWindows(env, { attachment_raw: 12 });
    expect(put.status).toBe(200);
    // Partial updates merge: the other category keeps its safe default.
    expect((put.body as { windows_hours: Record<string, number> }).windows_hours).toEqual({
      attachment_raw: 12,
      corpus_raw: 24,
    });

    const again = (await (
      await callApp(env, "/api/retention", { headers: auth })
    ).json()) as { windows_hours: Record<string, number> };
    expect(again.windows_hours.attachment_raw).toBe(12);

    const bad = await putWindows(env, { audit_receipts: 24 });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("unsupported_retention");
    const refusals = bad.body.refusals as Array<{ category: string; reason: string }>;
    expect(refusals[0].category).toBe("audit_receipts");
    expect(refusals[0].reason).toMatch(/retained/i);

    // A refused update changes nothing.
    const after = (await (
      await callApp(env, "/api/retention", { headers: auth })
    ).json()) as { windows_hours: Record<string, number> };
    expect(after.windows_hours).toEqual({ attachment_raw: 12, corpus_raw: 24 });

    // The audit names the configuration, never content.
    const actions = await auditActions(env.DB as FakeD1);
    const configured = actions.find((a) => a.startsWith("retention:configured"));
    expect(configured).toBeDefined();
    expect(configured).toContain("attachment_raw");
  });

  it("enforces the configured window on the cron entry", async () => {
    const env = makeEnv();
    const db = env.DB as FakeD1;
    const r2 = env.CORPUS as FakeR2;
    await getState(env as never);
    await saveRetentionWindows(
      db as never,
      { attachment_raw: 48 },
      new Date().toISOString(),
    );
    await insertAttachment(db); // 25 hours old: inside a 48-hour window
    await r2.put("attachments/sub-1/att-1", new Uint8Array([1]));

    await worker.scheduled(
      {} as ScheduledEvent,
      env as never,
      {} as ExecutionContext,
    );
    expect(r2.keys()).toEqual(["attachments/sub-1/att-1"]);

    // Once the configured window lapses, the next scheduled sweep deletes.
    const receipt = await sweepRawBytes(
      env,
      new Date(Date.now() + 24 * HOUR).toISOString(),
    );
    expect(categorySweep(receipt, "attachment_raw")).toMatchObject({ expired: 1, deleted: 1, verified: 1, failed: 0 });
    expect(r2.keys()).toEqual([]);
  });
});
