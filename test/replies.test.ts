import { describe, it, expect } from "vitest";
import { Script } from "node:vm";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { solveChallenge } from "../src/lib/pow";
import { unwrap } from "../src/lib/evidence";

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    POW_DIFFICULTY: "8",
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
      body: JSON.stringify({
        pow: { challenge: ch.challenge, nonce: String(nonce) },
      }),
    })
  ).json()) as { id: string; access_code: string };
  return { id: created.id, code: created.access_code };
}

async function reply(env: Record<string, unknown>, id: string, value: string) {
  return callApp(env, `/api/intake/${id}/reply`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ value }),
  });
}

async function followup(
  env: Record<string, unknown>,
  id: string,
  code: string,
  value: string,
) {
  return callApp(env, `/api/intake/${id}/followup`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ access_code: code, value }),
  });
}

async function readThread(
  env: Record<string, unknown>,
  id: string,
  code: string,
) {
  const res = await callApp(env, `/api/intake/${id}/thread`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ access_code: code }),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      messages: Array<{ seq: number; role: string; kind: string; body: string }>;
    },
  };
}

async function rowsOf<T>(
  db: FakeD1,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const res = await (params.length ? stmt.bind(...params) : stmt).all<T>();
  return unwrap(res as never);
}

describe("reply thread via access code (C11)", () => {
  it("keeps one thread per submission, written by the operator and read by code", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const sent = await reply(env, id, "Can you confirm the roster dates?");
    expect(sent.status).toBe(200);

    const thread = await readThread(env, id, code);
    expect(thread.status).toBe(200);
    expect(thread.body.messages.length).toBe(1);
    expect(thread.body.messages[0].role).toBe("operator");
    expect(thread.body.messages[0].body).toBe("Can you confirm the roster dates?");

    // Operator-only write: no token, no reply.
    const denied = await callApp(env, `/api/intake/${id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    });
    expect(denied.status).toBe(401);
    expect((await readThread(env, id, code)).body.messages.length).toBe(1);
  });

  it("seals replies at rest and returns them only through the code", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    const secret = "MARKER-REPLY-9127 please confirm";
    await reply(env, id, secret);
    const db = env.DB as FakeD1;
    const stored = JSON.stringify(await db.prepare("SELECT * FROM messages").all());
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("please confirm");

    // A foreign code reads nothing and reveals nothing.
    const other = await createSubmission(env);
    const foreign = await readThread(env, id, other.code);
    expect(foreign.status).toBe(404);
    const missing = await callApp(env, `/api/intake/${id}/thread`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(422);
  });

  it("carries source follow-ups through the code into the same thread", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    await reply(env, id, "Any update on the Friday meeting?");
    const sent = await followup(env, id, code, "The roster changed on Friday.");
    expect(sent.status).toBe(200);

    const thread = await readThread(env, id, code);
    expect(thread.body.messages.map((m) => m.role)).toEqual([
      "operator",
      "submitter",
    ]);
    expect(thread.body.messages[1].kind).toBe("followup");
    expect(thread.body.messages[1].body).toBe("The roster changed on Friday.");

    // Wrong code writes nothing.
    const before = thread.body.messages.length;
    const otherCode = (await createSubmission(env)).code;
    const rejected = await followup(env, id, otherCode, "not mine");
    expect(rejected.status).toBe(404);
    expect((await readThread(env, id, code)).body.messages.length).toBe(before);
  });

  it("quarantines replies so source-facing text never gains names", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    await reply(env, id, "Zara Kline approved the roster");
    const thread = await readThread(env, id, code);
    expect(thread.body.messages[0].body).toContain("[person A]");
    expect(thread.body.messages[0].body).not.toContain("Zara");
    const db = env.DB as FakeD1;
    const dump = JSON.stringify([
      await db.prepare("SELECT * FROM messages").all(),
      await db.prepare("SELECT * FROM entities").all(),
      await db.prepare("SELECT * FROM entity_index").all(),
    ]);
    expect(dump).not.toContain("Zara");
  });

  it("keeps contact open after the round loop completes", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    await (env.DB as FakeD1)
      .prepare("UPDATE submissions SET status = 'complete' WHERE id = ?")
      .bind(id)
      .run();
    expect((await reply(env, id, "One more question")).status).toBe(200);
    expect((await followup(env, id, code, "Happy to help")).status).toBe(200);
    const thread = await readThread(env, id, code);
    expect(thread.body.messages.length).toBe(2);
  });

  it("resumes into the thread driver in the survey shell", async () => {
    const res = await callApp(makeEnv(), "/survey.js");
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(() => new Script(js)).not.toThrow();
    expect(js).toContain("/thread");
    expect(js).toContain("/followup");
    expect(js).not.toContain("innerHTML");
  });
});
