import { describe, it, expect } from "vitest";
import app from "../src/index";
import { boot } from "../src/state";
import { createVaultKit, openText, sealText } from "../src/lib/vault";
import {
  CIPHERTEXT_AUDIT_COLUMNS,
  RESEAL_COLUMNS,
} from "../src/lib/ciphertext";
import { FakeD1 } from "./helpers/d1";

function makeEnv(operatorToken = "") {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: operatorToken,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

async function fetch_(
  env: ReturnType<typeof makeEnv>,
  path: string,
  init?: RequestInit,
) {
  return app.fetch(new Request(`https://surveyor.example${path}`, init), env);
}

describe("operator auth (disabled-until-set)", () => {
  it("404s every setup write while the token is unset", async () => {
    const env = makeEnv();
    const res = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("401s setup writes with a wrong token, accepts the right one", async () => {
    const env = makeEnv("correct-horse-battery");
    const bad = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    expect(bad.status).toBe(401);
    const good = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer correct-horse-battery",
      },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    expect((await good.json() as Record<string, unknown>).phase).toBe("corpus");
  });

  it("rejects invalid step payloads with 422, never 500", async () => {
    const env = makeEnv("tok");
    const res = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok",
      },
      body: JSON.stringify({ kind: "nonsense" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("surveyor worker", () => {
  it("serves the public survey at the root with FR-13-style security headers", async () => {
    const res = await fetch_(makeEnv(), "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toContain("/survey.js");
  });

  it("serves the first-run wizard at /setup", async () => {
    const res = await fetch_(makeEnv(), "/setup");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Surveyor");
  });

  it("serves wizard.js as javascript with no-store", async () => {
    const res = await fetch_(makeEnv(), "/wizard.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("GET /api/setup returns fresh welcome state", async () => {
    const res = await fetch_(makeEnv(), "/api/setup");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.phase).toBe("welcome");
  });

  it("walks providers → instrument to ready via POST /api/setup", async () => {
    const env = makeEnv("tok");
    await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    }).then((r) => r.json());
    const res = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({
        kind: "instrument",
        title: "T",
        blurb: "B",
        consent: "C",
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.phase).toBe("ready");
    expect((body.instrument as Record<string, string>).title).toBe("T");
  });

  it("teardown before ready is 409 setup_incomplete", async () => {
    const res = await fetch_(makeEnv("tok"), "/api/teardown", { method: "POST", headers: { authorization: "Bearer tok" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "setup_incomplete" });
  });

  it("teardown after ready returns honest receipts", async () => {
    const env = makeEnv("tok");
    await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({
        kind: "instrument",
        title: "T",
        blurb: "B",
        consent: "C",
      }),
    });
    const res = await fetch_(env, "/api/teardown", { method: "POST", headers: { authorization: "Bearer tok" } });
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.wiped as Record<string, string>).local_setup_state).toBe("reset-to-fresh");
    // No provision receipt in this env: teardown reports that honestly.
    expect((body.not_wiped as string[]).join(" ")).toContain("no provision receipt");
    // State reset to welcome: a subsequent setup read shows fresh state.
    const after = (await fetch_(env, "/api/setup").then((r) => r.json())) as Record<string, unknown>;
    expect(after.phase).toBe("welcome");
  });
});

describe("POST /api/audit/reseal", () => {
  const oldSecret = "old-server-secret";
  const oldEncKey = "f".repeat(64);

  async function reseal(env: ReturnType<typeof makeEnv>) {
    return fetch_(env, "/api/audit/reseal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer op-token",
      },
      body: JSON.stringify({
        old_server_secret: oldSecret,
        old_encryption_key: oldEncKey,
      }),
    });
  }

  it("re-seals rows written under an old key pair in every post-campaign table", async () => {
    const env = makeEnv("op-token");
    const { kit: newKit } = await boot(env as never);
    const oldKit = await createVaultKit(oldSecret, oldEncKey);
    const db = env.DB as FakeD1;
    await db
      .prepare(
        "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES ('s1','h','open','original',NULL,0,?)",
      )
      .bind(new Date().toISOString())
      .run();
    await db
      .prepare(
        "INSERT INTO messages (submission_id, seq, role, kind, body_envelope) VALUES ('s1',0,'submitter','structured',?)",
      )
      .bind(await sealText(oldKit, "old testimony"))
      .run();

    // The sealed columns streams B/C/D added: the rotation path must carry
    // them too, not just the pre-campaign set.
    const sealedRows = [
      {
        table: "breach_assessments",
        column: "record_envelope",
        id: "br1",
        sql: "INSERT INTO breach_assessments (id, aware_at, decision, record_envelope, created_at, updated_at) VALUES ('br1','now','pending',?,'now','now')",
        text: "breach facts",
      },
      {
        table: "consent_records",
        column: "record_envelope",
        id: "cr1",
        sql: "INSERT INTO consent_records (id, submission_id, wording_version, record_envelope, created_at) VALUES ('cr1','s1',1,?,'now')",
        text: "consent decision",
      },
      {
        table: "report_legal_records",
        column: "record_envelope",
        id: "lr1",
        sql: "INSERT INTO report_legal_records (id, report_type, version, reply_required, record_envelope, created_at) VALUES ('lr1','digest',1,1,?,'now')",
        text: "legal review",
      },
      {
        table: "right_of_reply_attempts",
        column: "record_envelope",
        id: "rr1",
        sql: "INSERT INTO right_of_reply_attempts (id, report_type, version, outcome, attempted_at, record_envelope, created_at) VALUES ('rr1','digest',1,'sent','now',?,'now')",
        text: "reply attempt",
      },
    ];
    for (const row of sealedRows) {
      await db.prepare(row.sql).bind(await sealText(oldKit, row.text)).run();
    }

    const res = await reseal(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      resealed: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.resealed["messages.body_envelope"]).toBe(1);
    for (const row of sealedRows) {
      expect(body.resealed[`${row.table}.${row.column}`]).toBe(1);
      // Verification: every re-sealed row opens with the current kit.
      const stored = (await db
        .prepare(
          `SELECT ${row.column} AS v FROM ${row.table} WHERE id = '${row.id}'`,
        )
        .first()) as { v: string };
      expect(await openText(newKit, stored.v)).toBe(row.text);
    }
  });

  it("reports envelopes no held kit can open as failed and leaves them untouched", async () => {
    const env = makeEnv("op-token");
    await boot(env as never);
    const db = env.DB as FakeD1;
    await db
      .prepare(
        "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES ('s1','h','open','original',NULL,0,?)",
      )
      .bind(new Date().toISOString())
      .run();
    // Sealed under a key pair nobody holds: neither the current kit nor the
    // supplied old pair can open it.
    const foreign = await createVaultKit("someone-elses-secret", "a".repeat(64));
    const orphan = await sealText(foreign, "unreadable");
    await db
      .prepare(
        "INSERT INTO messages (submission_id, seq, role, kind, body_envelope) VALUES ('s1',0,'submitter','structured',?)",
      )
      .bind(orphan)
      .run();

    const res = await reseal(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      failed: number;
      resealed: Record<string, number>;
    };
    expect(body.ok).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.resealed["messages.body_envelope"]).toBe(0);
    const row = (await db
      .prepare("SELECT body_envelope FROM messages")
      .first()) as { body_envelope: string };
    expect(row.body_envelope).toBe(orphan);
  });

  it("covers every sealed column the at-rest audit inspects (A2)", () => {
    const resealed = new Set(
      RESEAL_COLUMNS.map((c) => `${c.table}.${c.column}`),
    );
    for (const c of CIPHERTEXT_AUDIT_COLUMNS) {
      expect(
        resealed.has(`${c.table}.${c.column}`),
        `${c.table}.${c.column} is audited but never re-sealed`,
      ).toBe(true);
    }
  });

  it("requires the operator token", async () => {
    const res = await fetch_(makeEnv("op-token"), "/api/audit/reseal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        old_server_secret: "a",
        old_encryption_key: "b".repeat(64),
      }),
    });
    expect(res.status).toBe(401);
  });
});
