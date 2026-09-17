// C7 — registry audio rescue lane: when the keyless Workers AI default
// cannot transcribe a file, an audio-tagged registry entry (the operator's
// BYOK key) services it under the same chunk plan and caps. Provenance
// records the provider that produced the transcript; with neither path
// configured the file stays held with the missing capability named.

import { describe, it, expect, vi } from "vitest";

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function mediaHeaders(
  filename: string,
  mediaType: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-filename": encodeURIComponent(filename),
    "content-type": mediaType,
  };
}

const AUDIO_ENTRY = {
  kind: "openai-compatible",
  label: "groq-audio",
  secret_slot: "GROQ_API_KEY",
  model: "whisper-large-v3-turbo",
  base_url: "https://llm.example/v1",
  capabilities: ["audio"],
};

async function setup(
  extra: Record<string, unknown> = {},
  providers: unknown[] = [],
) {
  const { default: app } = await import("../src/index");
  const { FakeD1 } = await import("./helpers/d1");
  const { FakeR2 } = await import("./helpers/r2");
  const db = new FakeD1();
  const corpus = new FakeR2();
  const env: Record<string, unknown> = {
    DB: db as never,
    CORPUS: corpus as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "s",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    GROQ_API_KEY: "byok-key",
    ...extra,
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
  return { env, db, corpus, callApp };
}

type CallApp = (
  path: string,
  init?: RequestInit,
) => Response | Promise<Response>;

async function uploadAndDrain(
  callApp: CallApp,
  headers: Record<string, string>,
): Promise<{ drained: number; outcomes: Array<{ reason: string | null }> }> {
  await callApp("/api/corpus", {
    method: "POST",
    headers,
    body: "fake-mp3-bytes",
  });
  return (await (
    await callApp("/api/corpus/drain", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    })
  ).json()) as { drained: number; outcomes: Array<{ reason: string | null }> };
}

async function corpusDocs(
  callApp: CallApp,
): Promise<Array<{ status: string; verdict: string; reason: string | null }>> {
  const out = (await (
    await callApp("/api/corpus", { headers: auth })
  ).json()) as { docs: Array<{ status: string; verdict: string; reason: string | null }> };
  return out.docs;
}

async function telemetry(
  callApp: CallApp,
): Promise<Array<{ tier: string; outcome: string | null }>> {
  return (await (
    await callApp("/api/telemetry", { headers: auth })
  ).json()) as Array<{ tier: string; outcome: string | null }>;
}

describe("registry audio rescue lane (C7)", () => {
  it("selects the audio-tagged rescue lane when the keyless default fails", async () => {
    const requests: Array<{
      url: string;
      auth: string | undefined;
      body: unknown;
    }> = [];
    vi.stubGlobal(
      "fetch",
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          auth:
            (init?.headers as Record<string, string> | undefined)
              ?.authorization ?? undefined,
          body: init?.body,
        });
        return new Response(
          JSON.stringify({ text: "Zara Kline approved the roster" }),
          { status: 200 },
        );
      },
    );
    try {
      const { db, corpus, callApp } = await setup(
        {
          AI: {
            run: async () => {
              throw new Error("workers-ai down");
            },
          },
        },
        [AUDIO_ENTRY],
      );
      const out = await uploadAndDrain(
        callApp,
        mediaHeaders("interview.mp3", "audio/mpeg"),
      );
      expect(out.drained).toBe(1);

      const docs = await corpusDocs(callApp);
      expect(docs[0].status).toBe("rescued");
      expect(docs[0].verdict).toBe("gated");
      expect(docs[0].reason).toBeNull();

      // Gated before the mirror; raw bytes cleared; name sealed.
      const fts = JSON.stringify(
        await db.prepare("SELECT * FROM corpus_fts").all(),
      );
      expect(fts).toContain("roster");
      expect(fts).not.toContain("Zara Kline");
      expect(corpus.keys()).toEqual([]);

      // Provenance records the provider that produced the transcript.
      const tele = await telemetry(callApp);
      expect(
        tele.some(
          (t) => t.tier === "groq-audio" && t.outcome === "rescued",
        ),
      ).toBe(true);

      // The operator's BYOK key travelled to the transcription endpoint.
      const drainCalls = requests.filter((r) =>
        r.url.includes("/audio/transcriptions"),
      );
      expect(drainCalls.length).toBe(1);
      expect(drainCalls[0].url).toBe(
        "https://llm.example/v1/audio/transcriptions",
      );
      expect(drainCalls[0].auth).toBe("Bearer byok-key");
      expect(drainCalls[0].body).toBeInstanceOf(FormData);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the keyless default as the first path and never spends the rescue", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ text: "unused" }), { status: 200 });
    });
    try {
      const { callApp } = await setup(
        { AI: { run: async () => ({ text: "Keyless transcript" }) } },
        [AUDIO_ENTRY],
      );
      const out = await uploadAndDrain(
        callApp,
        mediaHeaders("interview.wav", "audio/wav"),
      );
      expect(out.drained).toBe(1);
      const docs = await corpusDocs(callApp);
      expect(docs[0].status).toBe("transcribed");
      const tele = await telemetry(callApp);
      expect(
        tele.some(
          (t) => t.tier === "workers-ai-whisper" && t.outcome === "transcribed",
        ),
      ).toBe(true);
      expect(calls).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never sends audio to a chat-only registry entry", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("{}", { status: 200 });
    });
    try {
      const { corpus, callApp } = await setup(
        {
          AI: {
            run: async () => {
              throw new Error("workers-ai down");
            },
          },
        },
        [{ ...AUDIO_ENTRY, label: "chat-only", capabilities: [] }],
      );
      const out = await uploadAndDrain(
        callApp,
        mediaHeaders("interview.mp3", "audio/mpeg"),
      );
      expect(out.drained).toBe(0);
      expect(out.outcomes[0].reason).toMatch(/no audio-capable registry entry/i);
      expect(calls).toBe(0);
      // The raw bytes stay held inside the bounded retry window.
      expect(corpus.keys().length).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rescues through the registry when the Workers AI binding is absent", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ text: "Rescued transcript" }), {
          status: 200,
        }),
    );
    try {
      const { callApp } = await setup({}, [AUDIO_ENTRY]);
      const out = await uploadAndDrain(
        callApp,
        mediaHeaders("meeting.m4a", "audio/mp4"),
      );
      expect(out.drained).toBe(1);
      const docs = await corpusDocs(callApp);
      expect(docs[0].status).toBe("rescued");
      const tele = await telemetry(callApp);
      expect(
        tele.some((t) => t.tier === "groq-audio" && t.outcome === "rescued"),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds cleanly when no provider can transcribe", async () => {
    const { corpus, callApp } = await setup();
    const out = await uploadAndDrain(
      callApp,
      mediaHeaders("interview.mp3", "audio/mpeg"),
    );
    expect(out.drained).toBe(0);
    expect(out.outcomes[0].reason).toMatch(/held-audio/);
    expect(out.outcomes[0].reason).toMatch(/Workers AI/i);
    expect(corpus.keys().length).toBe(1);
  });
});
