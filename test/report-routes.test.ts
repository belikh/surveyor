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

  it("ticks corroborations but routes substance to a journalist pass", async () => {
    const env = makeEnv();
    await seedEvidence(env);
    const tick = (await (
      await callApp(env, "/api/reports/briefing/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ new_topics: [], corroborations: 3 }),
      })
    ).json()) as Record<string, unknown>;
    expect(tick.action).toBe("ticked");
    expect(tick.corroborations).toBe(3);

    const substantial = (await (
      await callApp(env, "/api/reports/briefing/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ new_topics: ["pay"], corroborations: 1 }),
      })
    ).json()) as Record<string, unknown>;
    expect(substantial.action).toBe("journalist_pass_required");
    // Corroboration count untouched by the refused tick.
    expect(substantial.corroborations).toBe(3);
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
    // Proper path: pre-configure automatics, then publish cleanly.
    await callApp(env, "/api/reports/briefing/config", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        config: { manual_required: false, min_submissions: 0 },
      }),
    });
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
