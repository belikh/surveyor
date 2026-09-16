import { describe, it, expect } from "vitest";
import {
  drainPlan,
  applyDrain,
  type DrainOutcome,
  type HeldDoc,
} from "../src/lib/drain";

function held(over: Partial<HeldDoc> = {}): HeldDoc {
  return {
    id: "d1",
    lane: "held-ocr",
    status: "held",
    bytes_b64: Buffer.from("fake-scan").toString("base64"),
    ...over,
  };
}

describe("drainPlan", () => {
  it("routes each held lane to its handler and skips non-held docs", () => {
    const plan = drainPlan([
      held({ id: "a", lane: "held-ocr" }),
      held({ id: "b", lane: "held-pdf" }),
      held({ id: "c", lane: "held-docx" }),
      held({ id: "d", lane: "held-xlsx" }),
      held({ id: "e", lane: "held-pptx" }),
      held({ id: "f", lane: "native", status: "parsed" }),
    ]);
    expect(plan.map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(plan.every((p) => p.handler.length > 0)).toBe(true);
  });

  it("plans nothing when no docs are held", () => {
    expect(drainPlan([held({ status: "parsed" })])).toEqual([]);
  });
});

describe("applyDrain", () => {
  it("transitions to parsed with gated text on success", () => {
    const r = applyDrain(held(), {
      ok: true,
      text: "Rosters run late",
      tier: "vision-model",
    });
    expect(r.status).toBe("parsed");
    expect(r.verdict).toBe("clean");
    expect(r.text).toBe("Rosters run late");
    expect(r.reason).toBeNull();
  });

  it("gates names before mirror write", () => {
    const r = applyDrain(held(), {
      ok: true,
      text: "Zara Kline approved it",
      tier: "vision-model",
    });
    expect(r.verdict).toBe("gated");
    expect(r.text).not.toContain("Zara Kline");
  });

  it("stays held with an actionable reason on failure", () => {
    const r = applyDrain(held(), {
      ok: false,
      reason: "no vision-capable provider configured",
      tier: "none",
    });
    expect(r.status).toBe("held");
    expect(r.verdict).toBe("pending");
    expect(r.reason).toMatch(/vision/i);
    expect(r.text).toBe("");
  });
});

describe("drain routes", () => {
  it("drains held docs end to end with telemetry and mirror grounding", async () => {
    const { default: app } = await import("../src/index");
    const { FakeD1 } = await import("./helpers/d1");
    const { FakeR2 } = await import("./helpers/r2");
    const corpus = new FakeR2();
    const env = {
      DB: new FakeD1() as never,
      CORPUS: corpus as never,
      OPERATOR_TOKEN: "op-token",
      SERVER_SECRET: "s",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
    };
    const auth = {
      "content-type": "application/json",
      authorization: "Bearer op-token",
    };
    const callApp = (e: Record<string, unknown>, path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://survey.example${path}`, init), e as never);

    await callApp(env, "/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "scan.png",
        content_type: "image/png",
        content_b64: Buffer.from("fake").toString("base64"),
      }),
    });

    // Raw bytes are held in R2, never D1.
    expect(corpus.keys()).toEqual(["corpus/" + corpus.keys()[0].split("/")[1]]);

    // No capable provider: the drain refuses loudly, file stays held.
    const refused = (await (
      await callApp(env, "/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number; outcomes: DrainOutcome[] };
    expect(refused.drained).toBe(0);
    expect(refused.outcomes[0].reason).toMatch(/no capable provider configured for held-ocr/i);
    expect(refused.outcomes[0].reason).toMatch(/vision-capable/i);

    let list = (await (
      await callApp(env, "/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ status: string; verdict: string; reason: string | null }> };
    expect(list.docs[0].status).toBe("held");
    expect(list.docs[0].verdict).toBe("pending");
    expect(list.docs[0].reason).toMatch(/held-ocr/);
  });

  it("drains through a capable provider, gates, quarantines, and clears raw", async () => {
    const { default: app } = await import("../src/index");
    const { FakeD1 } = await import("./helpers/d1");
    const { FakeR2 } = await import("./helpers/r2");
    const db = new FakeD1();
    const corpus = new FakeR2();
    const env = {
      DB: db as never,
      CORPUS: corpus as never,
      OPERATOR_TOKEN: "op-token",
      SERVER_SECRET: "s",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
      GROQ_API_KEY: "k",
    };
    const auth = {
      "content-type": "application/json",
      authorization: "Bearer op-token",
    };
    const callApp = (e: Record<string, unknown>, path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://survey.example${path}`, init), e as never);

    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        kind: "providers",
        providers: [
          {
            kind: "openai-compatible",
            label: "vision-llm",
            secret_slot: "GROQ_API_KEY",
            model: "m",
            base_url: "https://llm.example/v1",
            capabilities: ["vision"],
          },
        ],
      }),
    });
    await callApp(env, "/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "scan.png",
        content_type: "image/png",
        content_b64: Buffer.from("fake").toString("base64"),
      }),
    });

    const { vi } = await import("vitest");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: "Zara Kline approved the roster" } },
            ],
          }),
          { status: 200 },
        ),
    );
    const out = (await (
      await callApp(env, "/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number };
    vi.unstubAllGlobals();
    expect(out.drained).toBe(1);

    const list = (await (
      await callApp(env, "/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ id: string; status: string; verdict: string }> };
    expect(list.docs[0].status).toBe("OCRed");
    expect(list.docs[0].verdict).toBe("gated");

    // Mirror holds scrubbed text; raw bytes cleared from R2; name sealed.
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).not.toContain("Zara Kline");
    expect(fts).toContain("roster");
    expect(corpus.keys()).toEqual([]);
    const entities = await db.prepare("SELECT * FROM entities").all();
    expect(JSON.stringify(entities)).not.toContain("Zara Kline");
    // Telemetry records the outcome.
    const tele = (await (
      await callApp(env, "/api/telemetry", { headers: auth })
    ).json()) as Array<{ outcome: string | null }>;
    expect(tele.some((t) => t.outcome === "OCRed")).toBe(true);
  });
});

describe("keyless Workers AI lanes (R6)", () => {
  async function setup(ai: Record<string, unknown> | null, providers: unknown[] = []) {
    const { default: app } = await import("../src/index");
    const { FakeD1 } = await import("./helpers/d1");
    const { FakeR2 } = await import("./helpers/r2");
    const db = new FakeD1();
    const corpus = new FakeR2();
    const env: Record<string, unknown> = {
      DB: db as never,
      CORPUS: corpus as never,
      OPERATOR_TOKEN: "op-token",
      SERVER_SECRET: "s",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
      GROQ_API_KEY: "k",
    };
    if (ai) env.AI = ai;
    const auth = {
      "content-type": "application/json",
      authorization: "Bearer op-token",
    };
    const callApp = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://survey.example${path}`, init), env as never);
    if (providers.length > 0) {
      await callApp("/api/setup", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ kind: "providers", providers }),
      });
    }
    return { env, db, corpus, callApp, auth };
  }

  it("OCRs an image through the keyless Workers AI binding", async () => {
    const { db, corpus, callApp, auth } = await setup({
      run: async () => ({ answer: "Transcribed roster text" }),
    });
    await callApp("/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "scan.png",
        content_type: "image/png",
        content_b64: Buffer.from("scan").toString("base64"),
      }),
    });
    const out = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number };
    expect(out.drained).toBe(1);
    const list = (await (
      await callApp("/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ status: string }> };
    expect(list.docs[0].status).toBe("OCRed");
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("Transcribed roster text");
    expect(corpus.keys()).toEqual([]);
  });

  it("converts a PDF through keyless toMarkdown", async () => {
    const { db, callApp, auth } = await setup({
      toMarkdown: async () => ({ format: "markdown", data: "Extracted PDF body" }),
    });
    await callApp("/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "contract.pdf",
        content_type: "application/pdf",
        content_b64: Buffer.from("%PDF-1.4").toString("base64"),
      }),
    });
    const out = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number };
    expect(out.drained).toBe(1);
    const list = (await (
      await callApp("/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ status: string }> };
    expect(list.docs[0].status).toBe("parsed");
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("Extracted PDF body");
  });

  it("does not route vision to a text-only registry entry", async () => {
    const { callApp, auth } = await setup(null, [
      {
        kind: "openai-compatible",
        label: "text-only",
        secret_slot: "GROQ_API_KEY",
        model: "m",
        base_url: "https://llm.example/v1",
      },
    ]);
    await callApp("/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "scan.png",
        content_type: "image/png",
        content_b64: Buffer.from("scan").toString("base64"),
      }),
    });
    const out = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { outcomes: Array<{ reason: string | null }> };
    expect(out.outcomes[0].reason).toMatch(/vision-capable/i);
  });

  it("prefers the vision-tagged registry entry over the keyless tier", async () => {
    const { db, callApp, auth } = await setup(
      { run: async () => ({ answer: "keyless answer" }) },
      [
        {
          kind: "openai-compatible",
          label: "vision-llm",
          secret_slot: "GROQ_API_KEY",
          model: "m",
          base_url: "https://llm.example/v1",
          capabilities: ["vision"],
        },
      ],
    );
    const { vi } = await import("vitest");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Registry OCR text" } }],
          }),
          { status: 200 },
        ),
    );
    await callApp("/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "scan.png",
        content_type: "image/png",
        content_b64: Buffer.from("scan").toString("base64"),
      }),
    });
    const out = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number };
    vi.unstubAllGlobals();
    expect(out.drained).toBe(1);
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("Registry OCR text");
    expect(fts).not.toContain("keyless answer");
  });
});
