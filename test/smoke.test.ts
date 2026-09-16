import { describe, it, expect } from "vitest";
import {
  auditHeaders,
  auditCiphertext,
  solvePow,
  summarise,
  formatReceipt,
  REQUIRED_HEADERS,
} from "../src/lib/smoke";

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
  it("reports envelope shapes and flags malformed values", async () => {
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
    // Boot, then plant one clean and one malformed envelope.
    await call("/api/setup");
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
    const res = await call("/api/audit/ciphertext", {
      headers: { authorization: "Bearer op-token" },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect((body.messages as Record<string, number>).total).toBe(2);
    expect((body.messages as Record<string, number>).malformed).toBe(1);
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
