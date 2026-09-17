import { describe, it, expect, vi, afterEach } from "vitest";
import app, { EngineWorkflow, type EngineParams } from "../src/index";
import { getState } from "../src/state";
import { openText, sealText } from "../src/lib/vault";
import {
  buildCorpusToolbox,
  runResearchLine,
  type ResearchReceipt,
} from "../src/lib/research";
import type { ModelClient } from "../src/lib/serve";
import type { Bindings } from "../src/env";
import { FakeD1 } from "./helpers/d1";

// B1: a research line runs as a Workflow step that researches the gated
// mirror through read-only search/fetch tools, within step and token caps,
// with telemetry and a deterministic keyless floor.

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    ...extra,
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

async function seedCorpus(env: Record<string, unknown>) {
  const res = await callApp(env, "/api/corpus", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-filename": encodeURIComponent("notes.txt"),
      "content-type": "text/plain",
    },
    body: "Rosters are posted late on Tuesdays and wreck sleep",
  });
  expect(res.status).toBe(200);
}

function unwrapRows<T>(rows: T[] | { results: T[] }): T[] {
  return Array.isArray(rows) ? rows : rows.results;
}

describe("corpus toolbox", () => {
  it("searches and fetches the mirrored text only, never held material", async () => {
    const env = makeEnv();
    const { kit } = await getState(env as never);
    const db = env.DB as FakeD1;
    await db
      .prepare(
        "INSERT INTO corpus_docs (id, filename, lane, status, verdict, text_envelope, raw_key, reason, created_at) VALUES ('held-1', 'v1.sealed', 'held-ocr', 'held', 'pending', ?, NULL, NULL, ?)",
      )
      .bind(await sealText(kit, "raw held bytes"), new Date().toISOString())
      .run();
    const box = buildCorpusToolbox(db as never, kit);
    expect(await box.fetch("held-1")).toBeNull();
    expect(await box.search("raw")).toEqual([]);
  });
});

describe("workflow research step", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes a keyless line autonomously to a grounded finding draft", async () => {
    const env = makeEnv();
    await seedCorpus(env);
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
        body: JSON.stringify({ angle_id: angleId, spend_cap: 100 }),
      })
    ).json()) as { id: string };

    const wf = new EngineWorkflow(
      {} as ExecutionContext,
      env as never as Bindings,
    );
    const memo = new Map<string, unknown>();
    const names: string[] = [];
    const step = {
      do: async (name: string, cb: () => Promise<unknown>) => {
        names.push(name);
        if (!memo.has(name)) memo.set(name, await cb());
        return memo.get(name);
      },
    };
    const payload: EngineParams = { line_id: line.id, angle_id: angleId };
    await wf.run({ payload } as never, step as never);
    expect(names).toContain("research-line");

    const row = (await (env.DB as FakeD1)
      .prepare(
        "SELECT status, citations_json, findings_envelope, flags_json FROM research_lines WHERE id = ?",
      )
      .bind(line.id)
      .first()) as {
      status: string;
      citations_json: string;
      findings_envelope: string;
      flags_json: string;
    };
    expect(row.status).toBe("complete");
    const citations = JSON.parse(row.citations_json) as Array<{
      doc_id: string;
      snippet: string;
    }>;
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0].snippet).toContain("Rosters are posted late");
    const { kit } = await getState(env as never);
    const findings = await openText(kit, row.findings_envelope);
    expect(findings).toContain("Rosters");
    expect(JSON.parse(row.flags_json)).toEqual([]);

    const turns = unwrapRows(
      await (env.DB as FakeD1)
        .prepare(
          "SELECT tier, tool_calls AS toolCalls, label, outcome FROM telemetry WHERE label = ?",
        )
        .bind(`line:${angleId}`)
        .all<{
          tier: string;
          toolCalls: number;
          label: string;
          outcome: string | null;
        }>(),
    );
    const closedTurn = turns.find((t) => t.outcome === "complete");
    expect(closedTurn).toBeTruthy();
    expect(closedTurn?.tier).toBe("extractive");
    expect(closedTurn?.toolCalls).toBeGreaterThan(0);
  });
});

describe("capped research loop", () => {
  async function seedLine(env: Record<string, unknown>) {
    await seedCorpus(env);
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
        body: JSON.stringify({ angle_id: angleId, spend_cap: 100 }),
      })
    ).json()) as { id: string };
    const { kit } = await getState(env as never);
    return { angleId, lineId: line.id, kit };
  }

  it("halts at the step cap and holds the line", async () => {
    const env = makeEnv();
    const { angleId, lineId, kit } = await seedLine(env);
    const searching: ModelClient = {
      tier: "test-llm",
      complete: async () => JSON.stringify({ tool: "search", query: "roster" }),
    };
    const receipt = await runResearchLine(env.DB as never, kit, lineId, searching, {
      caps: { steps: 2, tokens: 100_000 },
    });
    expect(receipt.status).toBe("held");
    expect(receipt.steps).toBe(2);

    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status, flags_json FROM research_lines WHERE id = ?")
      .bind(lineId)
      .first()) as { status: string; flags_json: string };
    expect(row.status).toBe("held");
    expect(JSON.parse(row.flags_json)).toContain("cap-exceeded");

    const turn = (await (env.DB as FakeD1)
      .prepare(
        "SELECT tier, tool_calls AS toolCalls, outcome FROM telemetry WHERE label = ? AND outcome = 'capped'",
      )
      .bind(`line:${angleId}`)
      .first()) as { tier: string; toolCalls: number; outcome: string };
    expect(turn).toBeTruthy();
    expect(turn.toolCalls).toBe(2);
  });

  it("halts when the token cap is crossed", async () => {
    const env = makeEnv();
    const { lineId, kit } = await seedLine(env);
    const chatty: ModelClient = {
      tier: "test-llm",
      complete: async () =>
        JSON.stringify({
          tool: "search",
          query: "roster",
          padding: "x".repeat(4000),
        }),
    };
    const receipt = await runResearchLine(env.DB as never, kit, lineId, chatty, {
      caps: { steps: 50, tokens: 100 },
    });
    expect(receipt.status).toBe("held");
    expect(receipt.steps).toBe(1);
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT status FROM research_lines WHERE id = ?")
      .bind(lineId)
      .first()) as { status: string };
    expect(row.status).toBe("held");
  });

  it("drives search and fetch from a provider and completes on a valid final", async () => {
    const env = makeEnv();
    const { angleId, lineId, kit } = await seedLine(env);
    const docs = (await (
      await callApp(env, "/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ id: string }> };
    const docId = docs.docs[0].id;
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
    const client: ModelClient = {
      tier: "test-llm",
      complete: async () => {
        const action = script[call++];
        expect(action).toBeTruthy();
        return JSON.stringify(action);
      },
    };
    const receipt = await runResearchLine(env.DB as never, kit, lineId, client);
    expect(receipt.status).toBe("complete");
    expect(receipt.tier).toBe("test-llm");
    expect(receipt.steps).toBe(3);

    const row = (await (env.DB as FakeD1)
      .prepare(
        "SELECT citations_json, findings_envelope FROM research_lines WHERE id = ?",
      )
      .bind(lineId)
      .first()) as { citations_json: string; findings_envelope: string };
    expect(JSON.parse(row.citations_json)).toEqual([
      { doc_id: docId, snippet: "Rosters are posted late" },
    ]);
    expect(await openText(kit, row.findings_envelope)).toBe(
      "Rosters run late per the mirrored minutes",
    );
    const turn = (await (env.DB as FakeD1)
      .prepare(
        "SELECT tier, tool_calls AS toolCalls FROM telemetry WHERE label = ? AND outcome = 'complete'",
      )
      .bind(`line:${angleId}`)
      .first()) as { tier: string; toolCalls: number };
    expect(turn.tier).toBe("test-llm");
    expect(turn.toolCalls).toBe(3);
  });

  it("falls back to the floor rather than storing a fabricated citation", async () => {
    const env = makeEnv();
    const { lineId, kit } = await seedLine(env);
    const docs = (await (
      await callApp(env, "/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ id: string }> };
    const docId = docs.docs[0].id;
    const script = [
      { tool: "search", query: "roster" },
      { tool: "fetch", doc_id: docId },
      {
        tool: "final",
        findings: "A claim the mirror does not contain",
        citations: [{ doc_id: docId, snippet: "this text does not occur" }],
      },
    ];
    let call = 0;
    const client: ModelClient = {
      tier: "test-llm",
      complete: async () => JSON.stringify(script[call++]),
    };
    const receipt = await runResearchLine(env.DB as never, kit, lineId, client);
    expect(receipt.status).toBe("complete");
    expect(receipt.tier).toBe("extractive-fallback");
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT citations_json FROM research_lines WHERE id = ?")
      .bind(lineId)
      .first()) as { citations_json: string };
    expect(row.citations_json).not.toContain("this text does not occur");
  });

  it("falls back to the floor when the provider fails", async () => {
    const env = makeEnv();
    const { lineId, kit } = await seedLine(env);
    const broken: ModelClient = {
      tier: "test-llm",
      complete: async () => {
        throw new Error("provider down");
      },
    };
    const receipt = await runResearchLine(env.DB as never, kit, lineId, broken);
    expect(receipt.status).toBe("complete");
    expect(receipt.tier).toBe("extractive-fallback");
  });
});

describe("ungrounded research", () => {
  it("holds a line with no grounded exhibits instead of inventing one", async () => {
    const env = makeEnv();
    const { kit } = await getState(env as never);
    const db = env.DB as FakeD1;
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO angles (id, title, topics_json, rationale_envelope, exhibits_json, rank, status, flags_json, created_at) VALUES ('angle-1', 'Angle: roster', '[\"roster\"]', 'v1.x.y', '[]', 0, 'approved', '[]', ?)",
      )
      .bind(now)
      .run();
    await db
      .prepare(
        "INSERT INTO research_lines (id, angle_id, status, spend_cap, spend_used, created_at) VALUES ('line-1', 'angle-1', 'running', 100, 0, ?)",
      )
      .bind(now)
      .run();
    const receipt: ResearchReceipt = await runResearchLine(
      db as never,
      kit,
      "line-1",
      null,
    );
    expect(receipt.status).toBe("held");
    expect(receipt.flags).toContain("ungrounded");
    const row = (await db
      .prepare("SELECT status, flags_json FROM research_lines WHERE id = 'line-1'")
      .first()) as { status: string; flags_json: string };
    expect(row.status).toBe("held");
    expect(JSON.parse(row.flags_json)).toContain("ungrounded");
    const turn = (await db
      .prepare(
        "SELECT outcome FROM telemetry WHERE label = 'line:angle-1'",
      )
      .first()) as { outcome: string };
    expect(turn.outcome).toBe("held");
  });
});
