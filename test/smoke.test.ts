import { describe, it, expect } from "vitest";
import {
  auditHeaders,
  auditCiphertext,
  solvePow,
  summarise,
  formatReceipt,
  REQUIRED_HEADERS,
} from "../src/lib/smoke";
import {
  CIPHERTEXT_AUDIT_COLUMNS,
  sealedColumnsFromSchema,
  uncoveredSealedColumns,
} from "../src/lib/ciphertext";
import SCHEMA_SQL from "../src/db/schema.sql";

describe("auditHeaders", () => {
  it("passes when every required header matches", () => {
    const headers: Record<string, string> = {};
    for (const [name, expected] of REQUIRED_HEADERS) headers[name] = expected;
    const receipts = auditHeaders(headers);
    expect(receipts.every((r) => r.status === "pass")).toBe(true);
  });

  it("fails with the expected value named", () => {
    const receipts = auditHeaders({
      "content-security-policy": "default-src 'self'",
    });
    const csp = receipts.find((r) => r.name === "header:content-security-policy");
    expect(csp?.status).toBe("fail");
    expect(csp?.detail).toContain("default-src 'none'");
    expect(csp?.detail).toContain("default-src 'self'");
  });
});

describe("solvePow", () => {
  it("finds a nonce meeting the difficulty", async () => {
    const challenge = "test-challenge";
    const nonce = await solvePow(challenge, 8);
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${challenge}:${nonce}`),
      ),
    );
    let bits = 0;
    for (const byte of digest) {
      if (byte === 0) {
        bits += 8;
        continue;
      }
      let mask = 0x80;
      while (mask && !(byte & mask)) {
        bits++;
        mask >>= 1;
      }
      break;
    }
    expect(bits).toBeGreaterThanOrEqual(8);
  });
});

describe("auditCiphertext", () => {
  it("passes valid envelopes with no plaintext", () => {
    const r = auditCiphertext(["v1.abc.def", "v1.ghi.jkl"], ["Zara Kline"]);
    expect(r.status).toBe("pass");
  });

  it("fails malformed envelopes", () => {
    const r = auditCiphertext(["plaintext-runner"], []);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/not v1 envelopes/);
  });

  it("fails when a forbidden marker appears in storage", () => {
    const r = auditCiphertext(["v1.abc.ZaraKline"], ["ZaraKline"]);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/plaintext marker/);
  });
});

describe("summarise + formatReceipt", () => {
  it("fails overall if any check failed, and counts correctly", () => {
    const s = summarise([
      { name: "a", status: "pass", detail: "" },
      { name: "b", status: "fail", detail: "" },
      { name: "c", status: "skip", detail: "" },
    ]);
    expect(s).toEqual({ ok: false, passed: 1, failed: 1, skipped: 1 });
  });

  it("skips never count as passes", () => {
    const s = summarise([{ name: "a", status: "skip", detail: "" }]);
    expect(s.ok).toBe(true);
    expect(s.passed).toBe(0);
  });

  it("formats receipts with a clear mark", () => {
    expect(formatReceipt({ name: "x", status: "pass", detail: "d" })).toBe(
      "[PASS] x — d",
    );
    expect(formatReceipt({ name: "x", status: "fail", detail: "d" })).toContain(
      "[FAIL]",
    );
    expect(formatReceipt({ name: "x", status: "skip", detail: "d" })).toContain(
      "[SKIP]",
    );
  });
});

describe("ciphertext audit endpoint", () => {
  const auth = { authorization: "Bearer op-token" };

  async function booted() {
    const { default: app } = await import("../src/index");
    const { FakeD1 } = await import("./helpers/d1");
    const db = new FakeD1();
    const env = {
      DB: db as never,
      OPERATOR_TOKEN: "op-token",
      SERVER_SECRET: "s",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
    };
    const call = (path: string, init?: RequestInit) =>
      app.fetch(
        new Request(`https://survey.example${path}`, init),
        env as never,
      );
    await call("/api/setup");
    return { db, call };
  }

  it("inspects every sealed column and reconciles the counts", async () => {
    const { db, call } = await booted();
    await db
      .prepare(
        "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES ('s1', 'h', 'open', 'original', NULL, 0, 'now')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO messages (submission_id, seq, role, kind, body_envelope) VALUES ('s1', 0, 'submitter', 'free', 'v1.abc.def')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO messages (submission_id, seq, role, kind, body_envelope) VALUES ('s1', 1, 'submitter', 'free', 'plaintext!')",
      )
      .run();
    // One malformed value in a column the old receipt never inspected.
    await db
      .prepare(
        "INSERT INTO angles (id, title, rationale_envelope, exhibits_json, rank, created_at) VALUES ('a1', 't', 'plain-rationale', '[]', 0, 'now')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO research_lines (id, angle_id, spend_cap, findings_envelope, created_at) VALUES ('l1', 'a1', 1, 'v1.aaa.bbb', 'now')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO report_entries (id, report_type, position, entry_envelope, created_at) VALUES ('e1', 'digest', 0, 'v1.ccc.ddd', 'now')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO attachments (id, submission_id, filename, media_type, size_bytes, status, raw_key, lane, reason, retry_after, created_at) VALUES ('at1', 's1', 'v1.fff.ggg', 'image/png', 1, 'uploaded', 'k', 'held-ocr', NULL, NULL, 'now')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO corpus_docs (id, filename, lane, status, verdict, text_envelope, created_at) VALUES ('c1', 'plain-filename', 'held-pdf', 'parsed', 'pass', 'v1.hhh.iii', 'now')",
      )
      .run();

    const res = await call("/api/audit/ciphertext", { headers: auth });
    const body = (await res.json()) as {
      ok: boolean;
      total: number;
      malformed: number;
      inspected: string[];
      missing: string[];
      columns: Record<string, { total: number; malformed: number }>;
    };
    expect(body.ok).toBe(false);
    expect(body.missing).toEqual([]);
    // Receipt counts reconcile with the schema: every sealed column has a
    // receipt, and the totals are the sums of the per-column counts.
    const sealed = sealedColumnsFromSchema(SCHEMA_SQL)
      .map((c) => `${c.table}.${c.column}`)
      .sort();
    expect(Object.keys(body.columns).sort()).toEqual(sealed);
    expect(body.inspected.sort()).toEqual(sealed);
    expect(body.columns["messages.body_envelope"]).toEqual({
      total: 2,
      malformed: 1,
    });
    expect(body.columns["angles.rationale_envelope"]).toEqual({
      total: 1,
      malformed: 1,
    });
    expect(body.columns["corpus_docs.filename"]).toEqual({
      total: 1,
      malformed: 1,
    });
    expect(body.columns["attachments.filename"]).toEqual({
      total: 1,
      malformed: 0,
    });
    expect(body.total).toBe(
      Object.values(body.columns).reduce((n, c) => n + c.total, 0),
    );
    expect(body.malformed).toBe(
      Object.values(body.columns).reduce((n, c) => n + c.malformed, 0),
    );
  });

  it("is operator-gated", async () => {
    const { default: app } = await import("../src/index");
    const { FakeD1 } = await import("./helpers/d1");
    const env = {
      DB: new FakeD1() as never,
      OPERATOR_TOKEN: "op-token",
      SERVER_SECRET: "s",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
    };
    const res = await app.fetch(
      new Request("https://survey.example/api/audit/ciphertext"),
      env as never,
    );
    expect(res.status).toBe(401);
  });
});

describe("sealed-column coverage gate (A13, #14)", () => {
  it("the audit names every sealed column in the schema", () => {
    expect(uncoveredSealedColumns(SCHEMA_SQL, CIPHERTEXT_AUDIT_COLUMNS)).toEqual(
      [],
    );
  });

  it("flags a new sealed column the audit does not cover", () => {
    // A future stream's table, exactly as it would merge into schema.sql.
    const future =
      "CREATE TABLE breach_assessments (id TEXT PRIMARY KEY, summary TEXT, breach_envelope TEXT NOT NULL);";
    expect(uncoveredSealedColumns(future, CIPHERTEXT_AUDIT_COLUMNS)).toEqual([
      { table: "breach_assessments", column: "breach_envelope" },
    ]);
  });

  it("treats a filename column as sealed", () => {
    const future =
      "CREATE TABLE notices (id TEXT PRIMARY KEY, filename TEXT NOT NULL, body TEXT);";
    expect(sealedColumnsFromSchema(future)).toEqual([
      { table: "notices", column: "filename" },
    ]);
  });

  it("ignores plain columns and table constraints", () => {
    const sql =
      "CREATE TABLE t (id TEXT PRIMARY KEY, note INTEGER NOT NULL, PRIMARY KEY (id, note), CHECK (note IN (1,2)));";
    expect(sealedColumnsFromSchema(sql)).toEqual([]);
  });
});
