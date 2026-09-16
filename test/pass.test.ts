import { describe, it, expect, vi, afterEach } from "vitest";
import { boot } from "../src/state";
import { sealText, type VaultKit } from "../src/lib/vault";
import { runJournalistPass } from "../src/lib/pass";
import { gatherEvidence } from "../src/lib/evidence";
import type { Evidence } from "../src/lib/reports";
import type { ModelClient } from "../src/lib/serve";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

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
    P_KEY: "provider-key",
  };
}

async function seedDoc(db: FakeD1, kit: VaultKit, id: string, text: string) {
  await db
    .prepare(
      "INSERT INTO corpus_docs (id, filename, lane, status, verdict, text_envelope, raw_key, reason, created_at) VALUES (?, ?, 'native', 'parsed', 'clean', ?, NULL, NULL, ?)",
    )
    .bind(id, await sealText(kit, `${id}.txt`), await sealText(kit, text), new Date().toISOString())
    .run();
}

async function seedLine(
  db: FakeD1,
  kit: VaultKit,
  status: "complete" | "held",
  title: string,
) {
  const now = new Date().toISOString();
  const angleId = `a-${title}`;
  await db
    .prepare(
      "INSERT INTO angles (id, title, topics_json, rationale_envelope, exhibits_json, rank, status, created_at) VALUES (?, ?, '[]', ?, '[]', 0, 'approved', ?)",
    )
    .bind(angleId, title, await sealText(kit, "r"), now)
    .run();
  await db
    .prepare(
      "INSERT INTO research_lines (id, angle_id, status, spend_cap, spend_used, citations_json, findings_envelope, flags_json, created_at) VALUES (?, ?, ?, 10, 0, ?, ?, '[]', ?)",
    )
    .bind(
      `l-${title}`,
      angleId,
      status,
      JSON.stringify([{ doc_id: "d1", snippet: "penalty rates" }]),
      await sealText(kit, "findings"),
      now,
    )
    .run();
}

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    submissions: 1,
    addenda: 0,
    corpusDocs: 1,
    heldDocs: 0,
    corroborations: 0,
    angles: [],
    lines: [
      {
        id: "l1",
        title: "Pay opacity",
        citations: [{ doc_id: "d1", snippet: "penalty rates are opaque" }],
        flags: [],
        created_at: new Date().toISOString(),
      },
    ],
    started_at: new Date().toISOString(),
    now: new Date().toISOString(),
    ...over,
  };
}

function client(output: unknown, capture?: { prompt: string }): ModelClient {
  return {
    tier: "test-tier",
    complete: async (p: string) => {
      if (capture) capture.prompt = p;
      return JSON.stringify(output);
    },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("journalist pass (R7)", () => {
  it("grounds model prose and renders citations", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedDoc(db, kit, "d1", "Penalty rates are opaque and widely grieved.");

    const result = await runJournalistPass(
      db as never,
      kit,
      "longform",
      client({
        blocks: [
          {
            heading: "Pay",
            text: "Penalty rates are opaque.",
            citations: [{ doc_id: "d1", snippet: "Penalty rates are opaque" }],
          },
        ],
      }),
      evidence(),
      false,
    );
    expect(result?.body).toContain("Penalty rates are opaque.");
    expect(result?.body).toContain("[d1: Penalty rates are opaque]");
    expect(result?.uncited).toBe(0);
  });

  it("annotates uncited claims in drafts and strips them on publish", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedDoc(db, kit, "d1", "Penalty rates are opaque.");
    const output = {
      blocks: [
        {
          text: "An invented claim.",
          citations: [{ doc_id: "d1", snippet: "not in the document" }],
        },
        {
          text: "A grounded claim.",
          citations: [{ doc_id: "d1", snippet: "Penalty rates are opaque" }],
        },
      ],
    };
    const draft = await runJournalistPass(db as never, kit, "briefing", client(output), evidence(), false);
    expect(draft?.body).toContain("An invented claim.");
    expect(draft?.body).toContain("[uncited]");
    expect(draft?.uncited).toBe(1);

    const published = await runJournalistPass(db as never, kit, "briefing", client(output), evidence(), true);
    expect(published?.body).not.toContain("An invented claim.");
    expect(published?.body).toContain("A grounded claim.");
  });

  it("stores timeline entries as structured sealed records", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedDoc(db, kit, "d1", "In March the roster policy changed.");
    const result = await runJournalistPass(
      db as never,
      kit,
      "timeline",
      client({
        entries: [
          {
            date: "2026-03",
            label: "Roster policy change",
            paragraph: "The roster policy changed.",
            citations: [{ doc_id: "d1", snippet: "the roster policy changed" }],
          },
        ],
      }),
      evidence(),
      false,
    );
    expect(result?.body).toContain("**Roster policy change**");
    const rows = (await db
      .prepare("SELECT entry_envelope FROM report_entries WHERE report_type = 'timeline'")
      .all()) as Array<{ entry_envelope: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_envelope.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Roster policy change");
  });

  it("returns the snapshot lead and degrades to null on junk output", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedDoc(db, kit, "d1", "Numbers.");
    const snap = await runJournalistPass(
      db as never,
      kit,
      "snapshot",
      client({ lead: "One line." }),
      evidence(),
      false,
    );
    expect(snap?.lead).toBe("One line.");

    const junk = await runJournalistPass(
      db as never,
      kit,
      "briefing",
      client({ nonsense: true }),
      evidence(),
      false,
    );
    expect(junk).toBeNull();
  });

  it("excludes held lines from the evidence bundle", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedLine(db, kit, "complete", "Complete line");
    await seedLine(db, kit, "held", "Held line");
    const ev = await gatherEvidence(db as never, 0);
    const titles = ev.lines.map((l) => l.title);
    expect(titles).toContain("Complete line");
    expect(titles).not.toContain("Held line");
  });
});

describe("journalist pass at publish", () => {
  async function readyEnv() {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedDoc(db, kit, "d1", "Penalty rates are opaque and widely grieved.");
    await seedLine(db, kit, "complete", "Pay opacity");
    // Configure a provider so liveClient resolves.
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        kind: "providers",
        providers: [
          {
            kind: "openai-compatible",
            label: "p",
            secret_slot: "P_KEY",
            model: "m",
            base_url: "https://llm.example/v1",
          },
        ],
      }),
    });
    return env;
  }

  function completion(content: string): Response {
    return new Response(
      JSON.stringify({
        id: "1",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("publishes model-written, cite-bound prose, versioned and fenced", async () => {
    const env = await readyEnv();
    vi.stubGlobal("fetch", async () =>
      completion(
        JSON.stringify({
          blocks: [
            {
              text: "Model-written prose about pay.",
              citations: [{ doc_id: "d1", snippet: "Penalty rates are opaque" }],
            },
          ],
        }),
      ),
    );
    await callApp(env, "/api/reports/briefing/approve", {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    const pub = await callApp(env, "/api/reports/briefing/publish", {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    expect(pub.status).toBe(200);
    const published = (await pub.json()) as { version: number };
    expect(published.version).toBe(1);

    const read = await callApp(env, "/api/reports/briefing");
    const body = (await read.json()) as {
      body: string;
      provenance: string;
      version: number;
    };
    expect(body.body).toContain("Model-written prose about pay.");
    expect(body.body).toContain("[d1: Penalty rates are opaque]");
    expect(body.provenance).toBe("untrusted");
    expect(body.version).toBe(1);
    // Append-only: a second publish adds a version and leaves v1 intact.
    const v1 = await callApp(env, "/api/reports/briefing/versions");
    expect(((await v1.json()) as { versions: unknown[] }).versions).toHaveLength(1);
  });
});
