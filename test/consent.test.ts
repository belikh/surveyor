// D5 — sensitive-category consent capture: granular per-category decisions
// recorded with the consent wording version, refusals respected at intake,
// and an audit surface that shows consent coverage.

import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { solveChallenge } from "../src/lib/pow";
import { categoryHmac, createVaultKit, openText } from "../src/lib/vault";
import { ConsentCaptureSchema, SENSITIVE_CATEGORIES } from "../src/lib/consent";
import {
  validateSetupStep,
  type SetupState,
} from "../src/lib/setup";

const TOKEN = "op-token";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    POW_SECRET: "pow-test-secret",
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
    new Request(`https://survey.example${path}`, init),
    env as never,
  );
}

async function configureInstrument(
  env: Record<string, unknown>,
  consent = "CONSENT-COPY-1",
) {
  await callApp(env, "/api/setup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ kind: "providers", providers: [] }),
  });
  await callApp(env, "/api/setup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      kind: "instrument",
      title: "Workplace survey",
      blurb: "Tell us",
      consent,
    }),
  });
}

async function createSubmission(
  env: Record<string, unknown>,
  consent?: Array<{ category: string; granted: boolean }>,
) {
  const ch = (await (
    await callApp(env, "/api/intake/challenge")
  ).json()) as { challenge: string; difficulty: number };
  const nonce = await solveChallenge(ch.challenge, ch.difficulty);
  const res = await callApp(env, "/api/intake", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      pow: { challenge: ch.challenge, nonce: String(nonce) },
      ...(consent ? { consent } : {}),
    }),
  });
  return (await res.json()) as { id: string; access_code: string };
}

async function submitSteps(
  env: Record<string, unknown>,
  id: string,
  accessCode: string,
  answers: Array<Record<string, unknown>>,
) {
  const res = await callApp(env, `/api/intake/${id}/steps`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ answers, access_code: accessCode }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe("sensitive-category consent capture", () => {
  it("records each decision sealed, with the consent wording version", async () => {
    const env = makeEnv();
    await configureInstrument(env);
    const { id } = await createSubmission(env, [
      { category: "health", granted: true },
      { category: "union", granted: false },
    ]);
    const db = env.DB as FakeD1;
    const rows = (await db
      .prepare(
        "SELECT submission_id, wording_version, record_envelope FROM consent_records WHERE submission_id = ?",
      )
      .bind(id)
      .all()) as { results: Array<Record<string, string>> };
    expect(rows.results.length).toBe(1);
    expect(Number(rows.results[0].wording_version)).toBe(1);
    // The decisions are sealed: the row carries an envelope, not plaintext.
    expect(rows.results[0].record_envelope.startsWith("v1.")).toBe(true);
    const kit = await createVaultKit(env.SERVER_SECRET as string, env.ENCRYPTION_KEY as string);
    const capture = ConsentCaptureSchema.parse(
      JSON.parse(await openText(kit, rows.results[0].record_envelope)),
    );
    expect(capture.decisions).toEqual([
      { category: "health", granted: true },
      { category: "union", granted: false },
    ]);
    expect(capture.wording_version).toBe(1);
    expect(capture.wording_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("bumps the wording version when the consent copy changes", () => {
    const current: SetupState = {
      phase: "instrument",
      providers: [],
      instrument: {
        title: "T",
        blurb: "B",
        consent: "Copy one",
        consent_version: 1,
      },
      installed_at: null,
    };
    const changed = validateSetupStep(current, {
      kind: "instrument",
      title: "T",
      blurb: "B",
      consent: "Copy two",
    });
    expect(changed.instrument?.consent_version).toBe(2);
    const unchanged = validateSetupStep(current, {
      kind: "instrument",
      title: "T",
      blurb: "B",
      consent: "Copy one",
    });
    expect(unchanged.instrument?.consent_version).toBe(1);
  });

  it("stores tagged answers only where consent was granted", async () => {
    const env = makeEnv();
    await configureInstrument(env);
    const { id, access_code } = await createSubmission(env, [
      { category: "health", granted: true },
      { category: "union", granted: false },
    ]);
    const step = await submitSteps(env, id, access_code, [
      { q: "roster", value: "The rosters were impossible", topic: "roster" },
      {
        q: "injury",
        value: "My back was injured on the job",
        topic: "injury",
        sensitive_categories: ["health"],
      },
      {
        q: "union",
        value: "I am a union delegate",
        topic: "union",
        sensitive_categories: ["union"],
      },
      {
        q: "politics",
        value: "I voted for the other party",
        topic: "politics",
        sensitive_categories: ["political"],
      },
    ]);
    expect(step.status).toBe(200);
    expect(step.body.saved).toBe(2);
    const refused = step.body.refused as Array<Record<string, unknown>>;
    expect(refused.map((r) => r.topic).sort()).toEqual(["politics", "union"]);
    expect(refused.find((r) => r.topic === "union")?.categories).toEqual([
      "union",
    ]);

    const db = env.DB as FakeD1;
    const messages = (await db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE submission_id = ?",
      )
      .bind(id)
      .first()) as { n: number };
    expect(messages.n).toBe(2);
    // Presence is joined by HMAC: the stored rows never name the category.
    const kit = await createVaultKit(env.SERVER_SECRET as string, env.ENCRYPTION_KEY as string);
    const cats = (await db
      .prepare(
        "SELECT category_hmac FROM message_categories WHERE submission_id = ?",
      )
      .bind(id)
      .all()) as { results: Array<{ category_hmac: string }> };
    expect(cats.results.length).toBe(1);
    expect(cats.results[0].category_hmac).toBe(await categoryHmac(kit, "health"));
    expect(cats.results[0].category_hmac).not.toBe("health");
  });

  it("fails closed on a category with no recorded decision", async () => {
    const env = makeEnv();
    await configureInstrument(env);
    const { id, access_code } = await createSubmission(env, []);
    const step = await submitSteps(env, id, access_code, [
      {
        q: "story",
        value: "Something about my health",
        topic: "injury",
        sensitive_categories: ["health"],
      },
    ]);
    expect(step.status).toBe(200);
    expect(step.body.saved).toBe(0);
    expect(
      (step.body.refused as Array<Record<string, unknown>>)[0].categories,
    ).toEqual(["health"]);
    const db = env.DB as FakeD1;
    const messages = (await db
      .prepare("SELECT COUNT(*) AS n FROM messages")
      .first()) as { n: number };
    expect(messages.n).toBe(0);
  });

  it("rejects unknown sensitive categories in the body", async () => {
    const env = makeEnv();
    await configureInstrument(env);
    const { id, access_code } = await createSubmission(env);
    const step = await submitSteps(env, id, access_code, [
      {
        q: "story",
        value: "v",
        topic: "injury",
        sensitive_categories: ["astrology"],
      },
    ]);
    expect(step.status).toBe(422);
  });

  it("carries consent to an addendum child", async () => {
    const env = makeEnv();
    await configureInstrument(env);
    const { id, access_code } = await createSubmission(env, [
      { category: "health", granted: true },
    ]);
    const step = await submitSteps(env, id, access_code, [
      {
        q: "injury",
        value: "My back was injured",
        topic: "injury",
        sensitive_categories: ["health"],
      },
    ]);
    expect(step.body.saved).toBe(1);

    const ch = (await (
      await callApp(env, "/api/intake/challenge")
    ).json()) as { challenge: string; difficulty: number };
    const nonce = await solveChallenge(ch.challenge, ch.difficulty);
    const child = (await (
      await callApp(env, `/api/intake/${id}/addendum`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          pow: { challenge: ch.challenge, nonce: String(nonce) },
          access_code,
        }),
      })
    ).json()) as { id: string };
    const childStep = await submitSteps(env, child.id, access_code, [
      {
        q: "injury",
        value: "More about the injury",
        topic: "injury",
        sensitive_categories: ["health"],
      },
    ]);
    expect(childStep.body.saved).toBe(1);
  });

  it("shows consent coverage to the operator only", async () => {
    const env = makeEnv();
    await configureInstrument(env);
    const a = await createSubmission(env, [
      { category: "health", granted: true },
      { category: "union", granted: false },
    ]);
    const b = await createSubmission(env, [
      { category: "union", granted: true },
    ]);
    await submitSteps(env, a.id, a.access_code, [
      {
        q: "injury",
        value: "My back was injured",
        topic: "injury",
        sensitive_categories: ["health"],
      },
    ]);
    await submitSteps(env, b.id, b.access_code, [
      {
        q: "union",
        value: "I am a delegate",
        topic: "union",
        sensitive_categories: ["union"],
      },
    ]);

    const denied = await callApp(env, "/api/intake/consent/coverage");
    expect(denied.status).toBe(401);

    const res = await callApp(env, "/api/intake/consent/coverage", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      captures: number;
      submissions: number;
      by_version: Array<{ wording_version: number; captures: number }>;
      categories: Array<{
        category: string;
        granted: number;
        refused: number;
        undecided: number;
        stored: number;
      }>;
      gaps: Array<Record<string, string>>;
    };
    expect(body.captures).toBe(2);
    expect(body.submissions).toBe(2);
    expect(body.by_version).toEqual([{ wording_version: 1, captures: 2 }]);
    const byCat = Object.fromEntries(
      body.categories.map((c) => [c.category, c]),
    );
    expect(byCat.health).toMatchObject({ granted: 1, refused: 0, stored: 1 });
    expect(byCat.union).toMatchObject({ granted: 1, refused: 1, stored: 1 });
    // Every stored category is covered by a grant: no gaps.
    expect(body.gaps).toEqual([]);
  });

  it("serves the sensitive categories and wording version to the survey", async () => {
    const env = makeEnv();
    await configureInstrument(env);
    const html = await (await callApp(env, "/survey")).text();
    expect(html).toContain("data-sensitive");
    for (const category of SENSITIVE_CATEGORIES) {
      expect(html).toContain(category);
    }
  });
});
