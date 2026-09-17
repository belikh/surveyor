import { describe, it, expect } from "vitest";
import app from "../src/index";
import { getState } from "../src/state";
import { finishLine, runResearchLine } from "../src/lib/research";
import type { ModelClient } from "../src/lib/serve";
import { FakeD1 } from "./helpers/d1";

// B2: spend is metered from actual model usage and the per-line cap is
// enforced against it. A line that reaches its cap halts into held and
// reports, rather than counting past the cap and burning more.

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
  };
}

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

function unwrapRows<T>(rows: T[] | { results: T[] }): T[] {
  return Array.isArray(rows) ? rows : rows.results;
}

async function seedLine(env: Record<string, unknown>, spendCap: number) {
  const upload = await callApp(env, "/api/corpus", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-filename": encodeURIComponent("notes.txt"),
      "content-type": "text/plain",
    },
    body: "Rosters are posted late on Tuesdays and wreck sleep",
  });
  expect(upload.status).toBe(200);
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
  const line = (await (
    await callApp(env, "/api/engine/lines", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ angle_id: angleId, spend_cap: spendCap }),
    })
  ).json()) as { id: string };
  const docs = (await (
    await callApp(env, "/api/corpus", { headers: auth })
  ).json()) as { docs: Array<{ id: string }> };
  const { kit } = await getState(env as never);
  return { angleId, lineId: line.id, docId: docs.docs[0].id, kit };
}

describe("real spend metering", () => {
  it("records the provider's reported usage on the line's spend row", async () => {
    const env = makeEnv();
    const { lineId, docId, kit } = await seedLine(env, 10_000);
    const script = [
      { tool: "search", query: "roster" },
      { tool: "fetch", doc_id: docId },
      {
        tool: "final",
        findings: "Rosters run late per the mirrored minutes",
        citations: [{ doc_id: docId, snippet: "Rosters are posted late" }],
      },
    ];
    let call = 0;
    const usage = [30, 40, 30];
    const client: ModelClient = {
      tier: "metered-llm",
      complete: async (_prompt, onUsage) => {
        onUsage?.({ tokens: usage[call] });
        return JSON.stringify(script[call++]);
      },
    };
    const receipt = await runResearchLine(env.DB as never, kit, lineId, client);
    expect(receipt.status).toBe("complete");
    expect(receipt.spend_used).toBe(100);
    expect(receipt.steps).toBe(3);

    const row = (await (env.DB as FakeD1)
      .prepare("SELECT spend_used, spend_cap, status FROM research_lines WHERE id = ?")
      .bind(lineId)
      .first()) as { spend_used: number; spend_cap: number; status: string };
    expect(row.spend_used).toBe(100);
    expect(row.spend_cap).toBe(10_000);
    expect(row.status).toBe("complete");
  });

  it("halts a line that reaches its spend cap and reports the cap", async () => {
    const env = makeEnv();
    const { angleId, lineId, kit } = await seedLine(env, 100);
    const client: ModelClient = {
      tier: "greedy-llm",
      complete: async (_prompt, onUsage) => {
        onUsage?.({ tokens: 5_000 });
        return JSON.stringify({ tool: "search", query: "roster" });
      },
    };
    const receipt = await runResearchLine(env.DB as never, kit, lineId, client);
    expect(receipt.status).toBe("held");
    expect(receipt.steps).toBe(1);
    expect(receipt.flags).toContain("cap-exceeded");
    expect(receipt.reason).toMatch(/spend cap/i);

    const row = (await (env.DB as FakeD1)
      .prepare("SELECT spend_used, spend_cap, status, flags_json FROM research_lines WHERE id = ?")
      .bind(lineId)
      .first()) as {
      spend_used: number;
      spend_cap: number;
      status: string;
      flags_json: string;
    };
    // Actual usage is recorded even on the crossing call: the cap is a
    // control, not a counter that hides what was spent.
    expect(row.spend_used).toBe(5_000);
    expect(row.status).toBe("held");
    expect(JSON.parse(row.flags_json)).toContain("cap-exceeded");

    const turn = (await (env.DB as FakeD1)
      .prepare(
        "SELECT tool_calls AS toolCalls, outcome FROM telemetry WHERE label = ? AND outcome = 'capped'",
      )
      .bind(`line:${angleId}`)
      .first()) as { toolCalls: number; outcome: string };
    expect(turn).toBeTruthy();
    expect(turn.toolCalls).toBe(1);
  });

  it("halts on the wall-time budget without further model calls", async () => {
    const env = makeEnv();
    const { lineId, kit } = await seedLine(env, 1_000_000);
    let calls = 0;
    const client: ModelClient = {
      tier: "slow-llm",
      complete: async (_prompt, onUsage) => {
        calls++;
        onUsage?.({ tokens: 1 });
        return JSON.stringify({ tool: "search", query: "roster" });
      },
    };
    let clock = 0;
    const receipt = await runResearchLine(env.DB as never, kit, lineId, client, {
      caps: { steps: 50, tokens: 100_000, spend: 100_000, wallMs: 60_000 },
      now: () => {
        clock += 30_000;
        return clock;
      },
    });
    expect(receipt.status).toBe("held");
    expect(receipt.steps).toBe(1);
    expect(calls).toBe(1);
    expect(receipt.flags).toContain("cap-exceeded");
    expect(receipt.reason).toMatch(/wall-time/i);
  });

  it("refuses a completion whose recorded spend is over the cap", async () => {
    const env = makeEnv();
    const { lineId, docId, kit } = await seedLine(env, 100);
    await (env.DB as FakeD1)
      .prepare("UPDATE research_lines SET spend_used = 200 WHERE id = ?")
      .bind(lineId)
      .run();
    const result = await finishLine(env.DB as never, kit, lineId, {
      citations: [{ doc_id: docId, snippet: "Rosters are posted late" }],
      findings: "Grounded but overspent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("over_cap");
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status FROM research_lines WHERE id = ?")
      .bind(lineId)
      .first()) as { status: string };
    expect(row.status).toBe("running");
  });

  it("leaves spend at zero when the client reports no usage", async () => {
    const env = makeEnv();
    const { lineId, kit } = await seedLine(env, 50);
    const broken: ModelClient = {
      tier: "silent-llm",
      complete: async () => {
        throw new Error("provider down");
      },
    };
    const receipt = await runResearchLine(env.DB as never, kit, lineId, broken);
    expect(receipt.status).toBe("complete");
    expect(receipt.tier).toBe("extractive-fallback");
    expect(receipt.spend_used).toBe(0);
  });
});

describe("spend route still bounds operator-recorded spend", () => {
  it("refuses an increment that would pass the cap atomically", async () => {
    const env = makeEnv();
    const { lineId } = await seedLine(env, 100);
    const ok = await callApp(env, `/api/engine/lines/${lineId}/spend`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 60 }),
    });
    expect(ok.status).toBe(200);
    const over = await callApp(env, `/api/engine/lines/${lineId}/spend`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ amount: 60 }),
    });
    expect(over.status).toBe(409);
    const rows = unwrapRows(
      await (env.DB as FakeD1)
        .prepare("SELECT spend_used FROM research_lines WHERE id = ?")
        .bind(lineId)
        .all<{ spend_used: number }>(),
    );
    expect(rows[0].spend_used).toBe(60);
  });
});
