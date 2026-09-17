import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { issueChallenge, solveChallenge } from "../src/lib/pow";
import { createPowKey } from "../src/lib/vault";

const TOKEN = "op-token";
const POW_SECRET = "pow-test-secret";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    POW_SECRET,
    POW_DIFFICULTY: "8",
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
  return app.fetch(
    new Request(`https://surveyor.example${path}`, init),
    env as never,
  );
}

async function solvedPow(env: Record<string, unknown>) {
  const ch = (await (
    await callApp(env, "/api/intake/challenge")
  ).json()) as { challenge: string; difficulty: number };
  const key = await createPowKey(POW_SECRET);
  void key;
  const nonce = await solveChallenge(ch.challenge, ch.difficulty);
  return { challenge: ch.challenge, nonce: String(nonce) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("intake walkthrough", () => {
  it("challenge → create → steps → resume → addendum → rounds → complete", async () => {
    const env = makeEnv();
    const pow = await solvedPow(env);

    // Create without an access path: PoW required.
    const denied = await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ pow: { challenge: "x", nonce: "0" } }),
    });
    expect(denied.status).toBe(422);

    const created = (await (
      await callApp(env, "/api/intake", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pow }),
      })
    ).json()) as Record<string, string>;
    expect(created.id).toBeTruthy();
    expect(created.access_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const id = created.id as string;
    const code = created.access_code as string;

    // Steps persist.
    const step = await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: [{ q: "role", value: "APO", topic: "role" }],
        access_code: code,
      }),
    });
    expect(step.status).toBe(200);

    // Resume by code from a fresh handle.
    const resumed = (await (
      await callApp(env, "/api/intake/resume", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ access_code: code }),
      })
    ).json()) as Record<string, string>;
    expect(resumed.id).toBe(id);

    // Rounds never re-ask covered topics.
    const r1 = (await (
      await callApp(env, `/api/intake/${id}/rounds`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ access_code: code }),
      })
    ).json()) as { questions: Array<{ topic: string }> };
    const topics1 = r1.questions.map((q) => q.topic);
    expect(topics1).not.toContain("role");
    // Answer round 1, ask round 2: no repeats across rounds either.
    await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: topics1.map((t) => ({ q: t, value: "some testimony", topic: t })), access_code: code,
      }),
    });
    const r2 = (await (
      await callApp(env, `/api/intake/${id}/rounds`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ access_code: code }),
      })
    ).json()) as { questions: Array<{ topic: string }>; done?: boolean };
    for (const q of r2.questions ?? []) {
      expect([...topics1, "role"]).not.toContain(q.topic);
    }

    // Addendum child under the same credential.
    const child = (await (
      await callApp(env, `/api/intake/${id}/addendum`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pow, access_code: code }),
      })
    ).json()) as Record<string, string>;
    expect(child.id).not.toBe(id);
    expect(child.access_code).toBe(code);
  });

  it("stores ciphertext only and quarantines names", async () => {
    const env = makeEnv();
    const pow = await solvedPow(env);
    const created = (await (
      await callApp(env, "/api/intake", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pow }),
      })
    ).json()) as Record<string, string>;
    const marker = "Zxqwv Testname";
    await callApp(env, `/api/intake/${created.id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: [
          { q: "story", value: `My supervisor ${marker} rostered me`, topic: "roster" },
        ],
        access_code: created.access_code,
      }),
    });
    // Full D1 dump must not contain the marker or the raw sentence.
    const db = env.DB as FakeD1;
    const dump = JSON.stringify([
      await db.prepare("SELECT * FROM messages").all(),
      await db.prepare("SELECT * FROM submissions").all(),
    ]);
    expect(dump).not.toContain(marker);
    expect(dump).not.toContain("rostered me");
    // Quarantine holds a label, not the name.
    const entities = (await db
      .prepare("SELECT label, name_envelope FROM entities")
      .all()) as Array<Record<string, string>>;
    expect(entities.length).toBeGreaterThan(0);
    expect(JSON.stringify(entities)).not.toContain(marker);
  });

  it("Turnstile-gated creation fails closed when the secret is set", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ success: false }), { status: 200 }),
    );
    const env = { ...makeEnv(), TURNSTILE_SECRET: "ts-secret" };
    const pow = await solvedPow(env);
    const res = await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ pow, turnstile_token: "tok" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("review findings", () => {
  it("rejects malformed submission ids without touching D1", async () => {
    const env = makeEnv();
    const res = await callApp(env, "/api/intake/not-a-uuid/rounds", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("addendum children never re-ask parent ground (family ledger)", async () => {
    const env = makeEnv();
    const pow = await solvedPow(env);
    const created = (await (
      await callApp(env, "/api/intake", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pow }),
      })
    ).json()) as Record<string, string>;
    const id = created.id as string;
    const code = created.access_code as string;
    await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: [{ q: "roster", value: "rosters are chaos", topic: "roster" }],
        access_code: code,
      }),
    });
    const child = (await (
      await callApp(env, `/api/intake/${id}/addendum`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pow, access_code: code }),
      })
    ).json()) as Record<string, string>;
    const r = (await (
      await callApp(env, `/api/intake/${child.id}/rounds`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ access_code: code }),
      })
    ).json()) as { questions: Array<{ topic: string }> };
    expect(r.questions.map((q) => q.topic)).not.toContain("roster");
  });

  it("quarantines single-token names in name-bearing contexts", async () => {
    const env = makeEnv();
    const pow = await solvedPow(env);
    const created = (await (
      await callApp(env, "/api/intake", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pow }),
      })
    ).json()) as Record<string, string>;
    await callApp(env, `/api/intake/${created.id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: [
          { q: "story", value: "I told Maddie about the roster", topic: "roster" },
        ],
        access_code: created.access_code,
      }),
    });
    const db = env.DB as FakeD1;
    const dump = JSON.stringify(await db.prepare("SELECT * FROM messages").all());
    expect(dump).not.toContain("Maddie");
    const groups = (await (
      await callApp(env, "/api/intake/entities/groups", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { groups: Array<{ subs: number }> };
    expect(groups.groups.length).toBeGreaterThan(0);
  });

  it("gates the groups endpoint behind the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/intake/entities/groups");
    expect(res.status).toBe(401);
  });
});

describe("submission writes require the access code", () => {
  async function mint(env: Record<string, unknown>) {
    const pow = await solvedPow(env);
    return (await (
      await callApp(env, "/api/intake", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pow }),
      })
    ).json()) as { id: string; access_code: string };
  }

  it("rejects missing and foreign codes without storing anything", async () => {
    const env = makeEnv();
    const victim = await mint(env);
    const decoy = await mint(env);

    const noCode = await callApp(env, `/api/intake/${victim.id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: [{ q: "x", value: "v", topic: "roster" }],
      }),
    });
    expect(noCode.status).toBe(422);

    const foreign = await callApp(env, `/api/intake/${victim.id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: [{ q: "x", value: "v", topic: "roster" }],
        access_code: decoy.access_code,
      }),
    });
    expect(foreign.status).toBe(404);

    const roundsNoCode = await callApp(env, `/api/intake/${victim.id}/rounds`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(roundsNoCode.status).toBe(422);

    const roundsForeign = await callApp(env, `/api/intake/${victim.id}/rounds`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ access_code: decoy.access_code }),
    });
    expect(roundsForeign.status).toBe(404);

    const db = env.DB as FakeD1;
    const messages = await db
      .prepare("SELECT COUNT(*) AS n FROM messages")
      .first<{ n: number }>();
    const topics = await db
      .prepare("SELECT COUNT(*) AS n FROM topics")
      .first<{ n: number }>();
    expect(messages?.n).toBe(0);
    expect(topics?.n).toBe(0);
  });

  it("rejects writes to a closed submission with 409", async () => {
    const env = makeEnv();
    const { id, access_code } = await mint(env);
    await (env.DB as FakeD1)
      .prepare("UPDATE submissions SET status = 'complete' WHERE id = ?")
      .bind(id)
      .run();
    const steps = await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        answers: [{ q: "x", value: "v", topic: "roster" }],
        access_code,
      }),
    });
    expect(steps.status).toBe(409);
    const rounds = await callApp(env, `/api/intake/${id}/rounds`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ access_code }),
    });
    expect(rounds.status).toBe(409);
  });
});

describe("write budget (amplified steps)", () => {
  function names(i0: number, n: number): string {
    const out: string[] = [];
    let x = i0;
    for (let i = 0; i < n; i++, x++) {
      let s = "";
      let v = x;
      for (let k = 0; k < 3; k++) {
        s = String.fromCharCode(97 + (v % 26)) + s;
        v = Math.floor(v / 26);
      }
      out.push("Z" + s);
    }
    return out.join(", ");
  }

  async function mint(env: Record<string, unknown>) {
    const pow = await solvedPow(env);
    return (await (
      await callApp(env, "/api/intake", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pow }),
      })
    ).json()) as { id: string; access_code: string };
  }

  it("caps name claims per answer and reserves the submission budget", async () => {
    const env = makeEnv();
    const { id, access_code } = await mint(env);
    const res = await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        access_code,
        answers: Array.from({ length: 4 }, (_, i) => ({
          q: `q${i}`,
          topic: `t${i}`,
          value: names(i * 180, 180),
        })),
      }),
    });
    expect(res.status).toBe(200);
    const entities = (await (env.DB as FakeD1)
      .prepare("SELECT COUNT(*) AS n FROM entities WHERE submission_id = ?")
      .bind(id)
      .first()) as { n: number };
    expect(entities.n).toBe(4 * 32);
  });

  it("refuses a request that would exceed the per-submission budget", async () => {
    const env = makeEnv();
    const { id, access_code } = await mint(env);
    const res = await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        access_code,
        answers: Array.from({ length: 32 }, (_, i) => ({
          q: `q${i}`,
          topic: `t${i}`,
          value: names(i * 180, 180),
        })),
      }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("write_budget_exceeded");
  });
});
