// D3 — breach assessment and NDB workflow: facts + decision captured, the
// thirty-day clock visible, and the OAIC statement draft exportable.

import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

const TOKEN = "op-token";
const DAY_MS = 24 * 60 * 60 * 1000;

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
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

const FACTS = {
  operator_name: "Example Newsroom Pty Ltd",
  operator_contact: "privacy@example-newsroom.org.au",
  description:
    "An export of survey records was left in a storage bucket with open access.",
  kinds_of_information: ["names and contact details", "employment details"],
  individuals_affected: 12,
  harm_assessment:
    "The records identify complainants and their allegations; serious harm is likely.",
  containment_steps: "The bucket was closed and access logs were pulled for review.",
  recommended_steps: "Watch for unexpected contact and report suspicious messages.",
};

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

async function createAssessment(
  env: Record<string, unknown>,
  body: Record<string, unknown> = {},
) {
  const res = await callApp(env, "/api/breach", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ...FACTS, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function decide(
  env: Record<string, unknown>,
  id: string,
  body: Record<string, unknown> = {
    outcome: "eligible",
    reasoning: "Serious harm is likely for the affected complainants.",
  },
) {
  return callApp(env, `/api/breach/${id}/decision`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
}

describe("breach assessment routes", () => {
  it("401s without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/breach");
    expect(res.status).toBe(401);
  });

  it("captures the facts and decision, with the clock visible", async () => {
    const env = makeEnv();
    const aware = daysAgo(0);
    const created = await createAssessment(env, { aware_at: aware });
    expect(created.status).toBe(201);
    expect(created.body.decision).toBe("pending");
    // Statutory window: 30 days from awareness (s 26WH).
    expect(
      Date.parse(created.body.deadline_at as string) - Date.parse(aware),
    ).toBe(30 * DAY_MS);
    expect(created.body.days_remaining).toBe(30);
    expect(created.body.overdue).toBe(false);

    const id = created.body.id as string;
    const decided = await decide(env, id);
    expect(decided.status).toBe(200);
    expect(
      ((await decided.json()) as Record<string, unknown>).decision,
    ).toBe("eligible");

    const listed = (await (
      await callApp(env, "/api/breach", { headers: auth })
    ).json()) as { assessments: Array<Record<string, unknown>> };
    expect(listed.assessments).toHaveLength(1);
    expect(listed.assessments[0].decision).toBe("eligible");
    expect(listed.assessments[0].days_remaining).toBe(30);
    expect(listed.assessments[0].deadline_at).toBe(created.body.deadline_at);

    const detail = (await (
      await callApp(env, `/api/breach/${id}`, { headers: auth })
    ).json()) as Record<string, never>;
    const facts = detail.facts as Record<string, unknown>;
    expect(facts.description).toBe(FACTS.description);
    expect(facts.kinds_of_information).toEqual(FACTS.kinds_of_information);
    expect(facts.individuals_affected).toBe(12);
    expect(facts.recommended_steps).toBe(FACTS.recommended_steps);
    expect(detail.reasoning).toBe(
      "Serious harm is likely for the affected complainants.",
    );
  });

  it("stores the assessment record sealed at rest", async () => {
    const env = makeEnv();
    const created = await createAssessment(env);
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT record_envelope FROM breach_assessments")
      .first()) as { record_envelope: string };
    expect(row.record_envelope.startsWith("v1.")).toBe(true);
    expect(row.record_envelope).not.toContain("open access");
  });

  it("shows the clock overdue once the window lapses", async () => {
    const env = makeEnv();
    const created = await createAssessment(env, { aware_at: daysAgo(31) });
    expect(created.body.overdue).toBe(true);
    expect(created.body.days_remaining).toBe(0);
    expect(created.body.days_overdue).toBeGreaterThanOrEqual(1);
  });

  it("exports the OAIC statement draft as a markdown attachment", async () => {
    const env = makeEnv();
    const created = await createAssessment(env, { aware_at: daysAgo(0) });
    const id = created.body.id as string;
    await decide(env, id);
    const res = await callApp(env, `/api/breach/${id}/statement`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const md = await res.text();
    expect(md).toContain(FACTS.operator_name);
    expect(md).toContain(FACTS.description);
    for (const kind of FACTS.kinds_of_information) expect(md).toContain(kind);
    expect(md).toContain(FACTS.recommended_steps);
    // The statement names the statutory assessment and notification duties.
    expect(md).toContain("26WH");
    expect(md).toContain("26WK");
    // The draft is dated by the assessment deadline.
    expect(md).toContain((created.body.deadline_at as string).slice(0, 10));
  });

  it("404s unknown assessments and rejects invalid bodies", async () => {
    const env = makeEnv();
    const missing = await callApp(env, "/api/breach/nope", { headers: auth });
    expect(missing.status).toBe(404);
    expect(
      (await callApp(env, "/api/breach/nope/statement", { headers: auth })).status,
    ).toBe(404);
    const bad = await createAssessment(env, { description: "" });
    expect(bad.status).toBe(422);
    const created = await createAssessment(env);
    const badDecision = await decide(env, created.body.id as string, {
      outcome: "maybe",
    });
    expect(badDecision.status).toBe(422);
    const unknownDecision = await decide(env, "nope");
    expect(unknownDecision.status).toBe(404);
  });
});
