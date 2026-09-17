import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { solveChallenge } from "../src/lib/pow";

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
    GROQ_API_KEY: "provider-key",
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
      body: JSON.stringify({ pow: { challenge: ch.challenge, nonce: String(nonce) } }),
    })
  ).json()) as { id: string; access_code: string };
  return { id: created.id, code: created.access_code };
}

async function configureProvider(env: Record<string, unknown>) {
  await callApp(env, "/api/setup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      kind: "providers",
      providers: [
        {
          kind: "openai-compatible",
          label: "p",
          secret_slot: "GROQ_API_KEY",
          model: "m",
          base_url: "https://llm.example/v1",
        },
      ],
    }),
  });
}

async function seedCorpus(env: Record<string, unknown>, text: string) {
  await callApp(env, "/api/corpus", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-filename": encodeURIComponent("notes.txt"),
      "content-type": "text/plain",
    },
    body: text,
  });
}

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "1",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("corpus-grounded rounds (R4)", () => {
  it("serves questions from the provider when the mirror has ground", async () => {
    const env = makeEnv();
    await configureProvider(env);
    await seedCorpus(env, "Rosters are posted late on Tuesdays; pay is opaque.");
    const { id, code } = await createSubmission(env);
    await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ answers: [{ q: "roster", value: "late rosters", topic: "roster" }], access_code: code }),
    });
    vi.stubGlobal("fetch", async () =>
      completion(
        JSON.stringify({
          questions: [{ topic: "penalty_rates", question: "How are penalty rates actually applied?" }],
        }),
      ),
    );
    const res = await callApp(env, `/api/intake/${id}/rounds`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ access_code: code }),
    });
    const body = (await res.json()) as {
      questions: Array<{ topic: string; question: string }>;
    };
    expect(body.questions[0].topic).toBe("penalty_rates");
  });

  it("falls back to the static pool with no provider", async () => {
    const env = makeEnv();
    const { id, code } = await createSubmission(env);
    await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ answers: [{ q: "roster", value: "x", topic: "roster" }], access_code: code }),
    });
    const res = await callApp(env, `/api/intake/${id}/rounds`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ access_code: code }),
    });
    const body = (await res.json()) as { questions: Array<{ topic: string }> };
    expect(body.questions.length).toBeGreaterThan(0);
    expect(body.questions.map((q) => q.topic)).not.toContain("roster");
  });

  it("never re-asks a topic the ground covered", async () => {
    const env = makeEnv();
    await configureProvider(env);
    await seedCorpus(env, "Rosters are posted late; pay is opaque.");
    const { id, code } = await createSubmission(env);
    // The source has already settled the roster topic.
    await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ answers: [{ q: "roster", value: "late rosters", topic: "roster" }], access_code: code }),
    });
    // Provider insists on a topic the source has already covered.
    vi.stubGlobal("fetch", async () =>
      completion(
        JSON.stringify({
          questions: [{ topic: "roster", question: "Tell me about rosters." }],
        }),
      ),
    );
    const res = await callApp(env, `/api/intake/${id}/rounds`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ access_code: code }),
    });
    const body = (await res.json()) as { questions: Array<{ topic: string }> };
    // Filtered out; static pool serves instead.
    expect(body.questions.map((q) => q.topic)).not.toContain("roster");
  });

  it("completes after the round cap and retriggers on new topics", async () => {
    const env = makeEnv();
    await seedCorpus(env, "Penalty rates and pay bands are contentious.");
    const { id, code } = await createSubmission(env);
    await callApp(env, `/api/intake/${id}/steps`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ answers: [{ q: "pay", value: "pay is opaque", topic: "pay" }], access_code: code }),
    });
    // Walk ROUNDS_MAX rounds; the next call must complete + retrigger.
    for (let i = 0; i < 3; i++) {
      const res = await callApp(env, `/api/intake/${id}/rounds`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ access_code: code }),
      });
      const body = (await res.json()) as {
        questions: Array<{ topic: string }>;
        done?: boolean;
      };
      if (body.done) break;
      await callApp(env, `/api/intake/${id}/steps`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          answers: body.questions.map((q) => ({ q: q.topic, value: "more", topic: q.topic })), access_code: code,
        }),
      });
    }
    const done = await callApp(env, `/api/intake/${id}/rounds`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ access_code: code }),
    });
    const body = (await done.json()) as {
      done?: boolean;
      retrigger?: unknown;
    };
    expect(body.done).toBe(true);
    // The completion response is anonymous: it must not carry the internal
    // retrigger detail (which topics other sources or the operator raised).
    expect(body.retrigger).toBeUndefined();
  });
});
