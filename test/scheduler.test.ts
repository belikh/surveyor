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

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

async function seedPublished(env: Record<string, unknown>, type: string) {
  await callApp(env, "/api/corpus", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      filename: "notes.txt",
      content_type: "text/plain",
      content_b64: b64("Rosters run late on Tuesdays"),
    }),
  });
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
  await callApp(env, `/api/reports/${type}/approve`, {
    method: "POST",
    headers: auth,
  });
  await callApp(env, `/api/reports/${type}/publish`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({}),
  });
}

describe("scheduler", () => {
  it("401s evaluation without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/scheduler/evaluate", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("re-renders lapsed scheduled reports with receipts", async () => {
    const env = makeEnv();
    await seedPublished(env, "briefing");
    await callApp(env, "/api/reports/briefing/config", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ config: { cadence_ms: 1 } }),
    });
    const out = (await (
      await callApp(env, "/api/scheduler/evaluate", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as {
      receipts: Array<{ type: string; action: string; danger: boolean }>;
    };
    const mine = out.receipts.find((r) => r.type === "briefing");
    expect(mine?.action).toBe("rendered");
    expect(mine?.danger).toBe(false);
    const read = (await (
      await callApp(env, "/api/reports/briefing")
    ).json()) as Record<string, unknown>;
    expect(read.version).toBe(2);
  });

  it("never auto-fires manual reports", async () => {
    const env = makeEnv();
    await seedPublished(env, "snapshot");
    await callApp(env, "/api/reports/snapshot/config", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ config: { frequency: "manual" } }),
    });
    const out = (await (
      await callApp(env, "/api/scheduler/evaluate", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { receipts: Array<{ type: string; action: string }> };
    expect(out.receipts.find((r) => r.type === "snapshot")?.action).toBe(
      "skipped",
    );
  });

  it("full-dynamic renders carry the danger marking", async () => {
    const env = makeEnv();
    await seedPublished(env, "timeline");
    await callApp(env, "/api/reports/timeline/config", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ config: { frequency: "full-dynamic" } }),
    });
    // New evidence: one more submission shifts the count.
    const ch = (await (
      await callApp(env, "/api/intake/challenge")
    ).json()) as { challenge: string; difficulty: number };
    const { solveChallenge } = await import("../src/lib/pow");
    const nonce = await solveChallenge(ch.challenge, ch.difficulty);
    await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        pow: { challenge: ch.challenge, nonce: String(nonce) },
      }),
    });
    const out = (await (
      await callApp(env, "/api/scheduler/evaluate", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as {
      receipts: Array<{ type: string; action: string; danger: boolean }>;
    };
    const mine = out.receipts.find((r) => r.type === "timeline");
    expect(mine?.action).toBe("rendered");
    expect(mine?.danger).toBe(true);
  }, 20000);
});
