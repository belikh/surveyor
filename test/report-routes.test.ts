import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

const TOKEN = "op-token";

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

function corpusHeaders(filename: string, mediaType: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-filename": encodeURIComponent(filename),
    "content-type": mediaType,
  };
}

async function seedEvidence(env: Record<string, unknown>) {
  // One parsed corpus doc.
  await callApp(env, "/api/corpus", {
    method: "POST",
    headers: corpusHeaders("notes.txt", "text/plain"),
    body: "Rosters run late on Tuesdays",
  });
  // One approved angle + cited line.
  const proposed = (await (
    await callApp(env, "/api/engine/angles/propose", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ topics: ["roster"] }),
    })
  ).json()) as { angles: Array<{ id: string }> };
  await callApp(env, `/api/engine/angles/${proposed.angles[0].id}/approve`, {
    method: "POST",
    headers: auth,
  });
  const line = (await (
    await callApp(env, "/api/engine/lines", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        angle_id: proposed.angles[0].id,
        spend_cap: 100,
      }),
    })
  ).json()) as { id: string };
  const docs = (await (
    await callApp(env, "/api/corpus", { headers: auth })
  ).json()) as { docs: Array<{ id: string }> };
  await callApp(env, `/api/engine/lines/${line.id}/complete`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      citations: [{ doc_id: docs.docs[0].id, snippet: "late" }],
      findings: "Rosters run late",
    }),
  });
}

// D7's legal gate releases one version at a time; tests that publish must
// record it for the pending version first.
async function recordLegal(env: Record<string, unknown>, type: string) {
  await callApp(env, `/api/reports/${type}/legal`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      reviewer: "A. Lawyer",
      notes: "Defamation and public-interest check complete",
    }),
  });
  await callApp(env, `/api/reports/${type}/reply`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      subject: "Example Pty Ltd",
      channel: "email",
      outcome: "no_response",
    }),
  });
}

describe("report routes", () => {
  it("blocks publish without approval and publishes after it", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    const blocked = await callApp(env, "/api/reports/dossier/publish", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(409);
    expect(
      ((await blocked.json()) as Record<string, string[]>).unmet,
    ).toContain("manual-approval");

    await callApp(env, "/api/reports/dossier/approve", {
      method: "POST",
      headers: auth,
    });
    await recordLegal(env, "dossier");
    const pub = (await (
      await callApp(env, "/api/reports/dossier/publish", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as Record<string, unknown>;
    expect(pub.version).toBe(1);

    // Public read serves the published words; second publish versions up.
    const read = (await (
      await callApp(env, "/api/reports/dossier")
    ).json()) as Record<string, unknown>;
    expect(read.version).toBe(1);
    expect(String(read.body)).toContain("dossier");
    await recordLegal(env, "dossier");
    await callApp(env, "/api/reports/dossier/publish", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    const read2 = (await (
      await callApp(env, "/api/reports/dossier")
    ).json()) as Record<string, unknown>;
    expect(read2.version).toBe(2);
    const versions = (await (
      await callApp(env, "/api/reports/dossier/versions")
    ).json()) as { versions: Array<{ version: number }> };
    expect(versions.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("retires the dormant two-tier tick route and its dead schema", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    const tick = await callApp(env, "/api/reports/briefing/tick", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ new_topics: ["pay"], corroborations: 1 }),
    });
    expect(tick.status).toBe(404);

    // The draft no longer advertises a pending-topics queue.
    const draft = (await (
      await callApp(env, "/api/reports/briefing/draft", { headers: auth })
    ).json()) as Record<string, unknown>;
    expect(draft.pending_topics).toBeUndefined();

    // The reports table carries neither of the retired columns.
    const raw = (await (env.DB as FakeD1)
      .prepare("PRAGMA table_info(reports)")
      .all()) as unknown;
    const names = (
      Array.isArray(raw)
        ? raw
        : (raw as { results: Array<{ name: string }> }).results
    ).map((c) => c.name);
    expect(names).not.toContain("pending_topics_json");
    expect(names).not.toContain("corroborations");
  });

  it("rejects unknown report types", async () => {
    const res = await callApp(makeEnv(), "/api/reports/nonsense");
    expect(res.status).toBe(404);
  });

  it("configures gates separately; publish cannot self-authorise", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    // Smuggling manual_required:false in the publish call is rejected:
    // publish takes no config at all.
    const sneak = await callApp(env, "/api/reports/briefing/publish", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ config: { manual_required: false } }),
    });
    expect(sneak.status).toBe(409);
    // Proper path: pre-configure automatics, record the legal release, then
    // publish cleanly.
    await callApp(env, "/api/reports/briefing/config", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        config: { manual_required: false, min_submissions: 0 },
      }),
    });
    await recordLegal(env, "briefing");
    const pub = (await (
      await callApp(env, "/api/reports/briefing/publish", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as Record<string, unknown>;
    expect(pub.version).toBe(1);
  });
});
