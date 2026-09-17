// New operator read routes the console needed (#67): the report index,
// the submissions list and detail, the research-line index and snapshot
// inspection. In-process app.fetch tests over the fake D1, asserting the
// empty and populated shapes and the operator gate.

import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";
import { getState } from "../src/state";
import { sha256Hex } from "../src/lib/snapshot";
import { sealText } from "../src/lib/vault";
import { REPORT_TYPES } from "../src/lib/reports";

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

describe("provider reorder with a secretless entry (#67)", () => {
  it("moves the visible entry using its stored order, not its visible index", async () => {
    const env = makeEnv({ TOKENROUTER_API_KEY: "tr-key" });
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        kind: "providers",
        providers: [
          {
            kind: "groq",
            label: "no-key",
            secret_slot: "GROQ_API_KEY",
            model: "m",
          },
          {
            kind: "tokenrouter",
            label: "visible",
            secret_slot: "TOKENROUTER_API_KEY",
            model: "m",
          },
        ],
      }),
    });
    const before = (await (
      await callApp(env, "/api/providers", { headers: auth })
    ).json()) as { entries: Array<{ label: string; order: number }> };
    expect(before.entries.map((e) => e.label)).toEqual(["visible"]);
    // The visible index is 0 but the stored index is 1: reorder must speak
    // stored order or it moves the invisible entry.
    expect(before.entries[0].order).toBe(1);
    const res = await callApp(env, "/api/providers/reorder", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ from: 1, to: 0 }),
    });
    expect(res.status).toBe(200);
    const after = (await (
      await callApp(env, "/api/providers", { headers: auth })
    ).json()) as { entries: Array<{ label: string; order: number }> };
    expect(after.entries[0].order).toBe(0);
    expect(after.entries[0].label).toBe("visible");
  });
});

describe("report index (#67)", () => {
  it("is operator-only", async () => {
    expect((await callApp(makeEnv(), "/api/reports")).status).toBe(401);
    expect(
      (await callApp(makeEnv({ OPERATOR_TOKEN: undefined }), "/api/reports"))
        .status,
    ).toBe(404);
  });

  it("lists all five types with version, cadence and gate status", async () => {
    const env = makeEnv();
    const res = await callApp(env, "/api/reports", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      types: Array<{
        type: string;
        enabled: boolean;
        current_version: number;
        pending_version: number;
        frequency: string;
        gates: { ok: boolean; unmet: string[] };
      }>;
    };
    expect(body.types.map((t) => t.type)).toEqual([...REPORT_TYPES]);
    for (const t of body.types) {
      expect(t.enabled).toBe(true);
      expect(t.current_version).toBe(0);
      expect(t.pending_version).toBe(1);
      expect(t.frequency).toBe("scheduled");
      // Default gates: manual approval outstanding.
      expect(t.gates.ok).toBe(false);
      expect(t.gates.unmet).toContain("manual-approval");
    }
  });
});

describe("submissions list and detail (#67)", () => {
  async function createSubmission(env: Record<string, unknown>) {
    const ch = (await (
      await callApp(env, "/api/intake/challenge")
    ).json()) as { challenge: string; difficulty: number };
    const { solveChallenge } = await import("../src/lib/pow");
    const nonce = await solveChallenge(ch.challenge, ch.difficulty);
    const created = (await (
      await callApp(env, "/api/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pow: { challenge: ch.challenge, nonce: String(nonce) },
          consent: [{ category: "health", granted: true }],
        }),
      })
    ).json()) as { id: string; access_code: string };
    return { id: created.id, code: created.access_code };
  }

  it("is operator-only", async () => {
    expect((await callApp(makeEnv(), "/api/submissions")).status).toBe(401);
  });

  it("lists an empty installation honestly", async () => {
    const res = await callApp(makeEnv(), "/api/submissions", {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { submissions: unknown[] }).submissions).toEqual(
      [],
    );
  });

  it("lists source traffic with consent and attachment state", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        access_code: code,
        answers: [
          {
            q: "What happened?",
            topic: "events",
            value:
              "My supervisor Jane Smith changed the roster without notice.",
          },
        ],
      }),
    });
    const upload = await callApp(env, `/api/intake/${id}/attachments`, {
      method: "POST",
      headers: {
        "x-access-code": code,
        "x-filename": encodeURIComponent("scan.png"),
        "content-type": "image/png",
      },
      body: "not really a png, but a held lane",
    });
    expect(upload.status).toBe(201);

    const list = (await (
      await callApp(env, "/api/submissions", { headers: auth })
    ).json()) as {
      submissions: Array<{
        id: string;
        status: string;
        round: number;
        consent_captures: number;
        consent: Array<{ category: string; granted: boolean }>;
        attachments: { total: number; raw_retained: number };
      }>;
    };
    expect(list.submissions).toHaveLength(1);
    const row = list.submissions[0];
    expect(row.id).toBe(id);
    expect(row.status).toBe("open");
    expect(row.round).toBe(0);
    expect(row.consent_captures).toBe(1);
    expect(row.consent).toContainEqual({ category: "health", granted: true });
    expect(row.attachments.total).toBe(1);
    expect(row.attachments.raw_retained).toBe(1);

    const detail = (await (
      await callApp(env, `/api/submissions/${id}`, { headers: auth })
    ).json()) as {
      submission: { id: string; status: string };
      messages: Array<{ role: string; kind: string; body: string }>;
      consent: { effective: Array<{ category: string; granted: boolean }> };
      attachments: Array<{
        media_type: string;
        status: string;
        raw_retained: boolean;
      }>;
      entities: Array<{ label: string; hmac: string; sealed: number }>;
      topics: Array<{ topic: string; source: string }>;
    };
    expect(detail.submission.id).toBe(id);
    const structured = detail.messages.find((m) => m.kind === "structured");
    expect(structured?.role).toBe("submitter");
    // Quarantine holds in the operator view: a pseudonym, never a name.
    expect(structured?.body).toContain("[person A]");
    expect(detail.consent.effective).toContainEqual({
      category: "health",
      granted: true,
    });
    expect(detail.attachments[0].media_type).toBe("image/png");
    expect(detail.entities[0]?.label).toBe("[person A]");
    expect(detail.entities[0]?.sealed).toBeGreaterThan(0);
    expect(detail.topics.map((t) => t.topic)).toContain("events");

    expect(
      (await callApp(env, "/api/submissions/not-a-uuid", { headers: auth }))
        .status,
    ).toBe(404);
  });
});

describe("research-line index (#67)", () => {
  it("lists every line with its angle, spend and flags", async () => {
    const env = makeEnv();
    // Seed the mirror then run angle -> approval -> line.
    await callApp(env, "/api/corpus", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-filename": encodeURIComponent("notes.txt"),
        "content-type": "text/plain",
      },
      body: "Rosters are posted late on Tuesdays and wreck sleep",
    });
    const proposed = (await (
      await callApp(env, "/api/engine/angles/propose", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ topics: ["roster"] }),
      })
    ).json()) as { angles: Array<{ id: string }> };
    const angleId = proposed.angles[0].id;
    await callApp(env, `/api/engine/angles/${angleId}/approve`, {
      method: "POST",
      headers: auth,
    });
    await callApp(env, "/api/engine/lines", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ angle_id: angleId, spend_cap: 100 }),
    });

    const res = await callApp(env, "/api/engine/lines", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{
        status: string;
        angle_title: string;
        spend_cap: number;
        spend_used: number;
        citation_count: number;
        flags: string[];
      }>;
    };
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].status).toBe("running");
    expect(body.lines[0].angle_title).toBeTruthy();
    expect(body.lines[0].spend_cap).toBe(100);
    expect(body.lines[0].spend_used).toBe(0);
    expect(body.lines[0].citation_count).toBe(0);
    expect(body.lines[0].flags).toEqual([]);
  });

  it("is operator-only", async () => {
    expect((await callApp(makeEnv(), "/api/engine/lines")).status).toBe(401);
  });
});

describe("snapshot inspection (#67)", () => {
  async function seedSnapshot(env: Record<string, unknown>, text: string) {
    const st = await getState(env as never);
    const id = crypto.randomUUID();
    const digest = text === "corrupt" ? "0".repeat(64) : await sha256Hex(text);
    const body = text === "corrupt" ? "the real text" : text;
    await (env.DB as FakeD1)
      .prepare(
        "INSERT INTO web_snapshots (id, requested_url, final_url, fetched_at, http_status, content_type, content_sha256, byte_length, extractor, extractor_version, r2_key, text_envelope, flags_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        "https://example.com/page",
        "https://example.com/page",
        "2026-01-01T00:00:00Z",
        200,
        "text/html",
        digest,
        body.length,
        "test",
        "1",
        `web/${id}.html`,
        await sealText(st.kit, body),
        JSON.stringify(["injection"]),
        "2026-01-01T00:00:00Z",
      )
      .run();
    return id;
  }

  it("opens a snapshot for the operator with the tamper check re-run", async () => {
    const env = makeEnv();
    const id = await seedSnapshot(env, "The page text");
    const res = await callApp(env, `/api/engine/snapshots/${id}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshot: { final_url: string; flags: string[]; provenance: string };
      text: string;
      verified: boolean;
    };
    expect(body.text).toBe("The page text");
    expect(body.verified).toBe(true);
    expect(body.snapshot.final_url).toBe("https://example.com/page");
    expect(body.snapshot.flags).toEqual(["injection"]);
    expect(body.snapshot.provenance).toBe("untrusted");
  });

  it("surfaces a digest mismatch instead of smoothing it over", async () => {
    const env = makeEnv();
    const id = await seedSnapshot(env, "corrupt");
    const body = (await (
      await callApp(env, `/api/engine/snapshots/${id}`, { headers: auth })
    ).json()) as { verified: boolean };
    expect(body.verified).toBe(false);
  });

  it("is operator-only and 404s unknown ids", async () => {
    const env = makeEnv();
    expect(
      (await callApp(env, `/api/engine/snapshots/${crypto.randomUUID()}`))
        .status,
    ).toBe(401);
    expect(
      (
        await callApp(env, `/api/engine/snapshots/${crypto.randomUUID()}`, {
          headers: auth,
        })
      ).status,
    ).toBe(404);
  });
});
