import { describe, it, expect } from "vitest";
import {
  MAX_TRANSCRIBE_CHUNKS,
  TRANSCRIBE_CHUNK_BYTES,
  TRANSCRIBE_MODEL,
  planMediaChunks,
  stitchTranscript,
  transcribeMedia,
} from "../src/lib/transcribe";
import { classifyLane } from "../src/lib/ingest";
import { drainPlan } from "../src/lib/drain";
import type { HeldDoc } from "../src/lib/drain";

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function mediaHeaders(filename: string, mediaType: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-filename": encodeURIComponent(filename),
    "content-type": mediaType,
  };
}

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "s",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    ...extra,
  };
}

describe("media lane classification (C6)", () => {
  it("classifies audio and video as held lanes, never rejected", () => {
    expect(classifyLane("interview.mp3", "audio/mpeg", 1024).lane).toBe("held-audio");
    expect(classifyLane("notes.m4a", "audio/mp4", 1024).lane).toBe("held-audio");
    expect(classifyLane("meeting.wav", "audio/wav", 1024).lane).toBe("held-audio");
    expect(classifyLane("briefing.mp4", "video/mp4", 1024).lane).toBe("held-video");
    expect(classifyLane("clip.mov", "video/quicktime", 1024).lane).toBe("held-video");
    expect(classifyLane("audio.bin", "audio/ogg", 1024).lane).toBe("held-audio");
    expect(classifyLane("video.bin", "video/webm", 1024).lane).toBe("held-video");
  });

  it("routes both media lanes to the transcription handler", () => {
    const doc = (lane: string): HeldDoc => ({
      id: lane,
      lane,
      status: "held",
      bytes_b64: "",
    });
    const plan = drainPlan([doc("held-audio"), doc("held-video")]);
    expect(plan.map((p) => p.handler)).toEqual(["transcribe", "transcribe"]);
  });
});

describe("media chunk planning (C6)", () => {
  it("keeps a short recording in one chunk", () => {
    const plan = planMediaChunks(4096);
    expect(plan).toEqual([{ index: 0, start: 0, end: 4096 }]);
  });

  it("covers long media with overlapping, ordered chunks", () => {
    const size = TRANSCRIBE_CHUNK_BYTES * 2 + 123;
    const plan = planMediaChunks(size);
    expect(plan.length).toBeGreaterThan(1);
    expect(plan[0].start).toBe(0);
    expect(plan[plan.length - 1].end).toBe(size);
    for (const [i, chunk] of plan.entries()) {
      expect(chunk.index).toBe(i);
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(TRANSCRIBE_CHUNK_BYTES);
      // Overlap, never a gap: the next chunk restarts inside the previous.
      if (i > 0) expect(chunk.start).toBeLessThan(plan[i - 1].end);
    }
  });

  it("plans nothing for an empty file", () => {
    expect(planMediaChunks(0)).toEqual([]);
  });
});

describe("transcript stitching (C6)", () => {
  it("drops the duplicated overlap run at the boundary", () => {
    expect(stitchTranscript("the roster was late", "was late and unfair")).toBe(
      "the roster was late and unfair",
    );
  });

  it("appends cleanly when there is nothing to dedupe", () => {
    expect(stitchTranscript("alpha beta", "gamma delta")).toBe(
      "alpha beta gamma delta",
    );
  });
});

describe("transcribeMedia (C6)", () => {
  it("calls the keyless model once per chunk and stitches the text", async () => {
    const calls: Array<{ model: string; audio: string }> = [];
    const texts = ["alpha beta", "beta gamma", "gamma delta"];
    const out = await transcribeMedia(
      async (model, inputs) => {
        calls.push({ model, audio: String(inputs.audio) });
        return { text: texts[calls.length - 1] };
      },
      new Uint8Array(2900),
      { chunkBytes: 1024, overlapBytes: 64, maxChunks: 10_000 },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.model === TRANSCRIBE_MODEL)).toBe(true);
    expect(calls.every((c) => c.audio.length > 0)).toBe(true);
    expect(out.transcription.text).toContain("alpha beta");
    expect(out.transcription.text).toContain("gamma delta");
    expect(out.transcription.chunks.length).toBe(calls.length);
    expect(out.transcription.chunks[0]).toMatchObject({ index: 0, start: 0 });
  });

  it("holds over-cap media instead of burning the model on it", async () => {
    let calls = 0;
    const out = await transcribeMedia(
      async () => {
        calls++;
        return { text: "x" };
      },
      new Uint8Array(1000),
      { chunkBytes: 100, overlapBytes: 10, maxChunks: 3 },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(calls).toBe(0);
    expect(out.reason).toMatch(/chunk/i);
    expect(out.reason).toMatch(/cap/i);
    // The default cap clears the largest file the ingest lane admits.
    expect(MAX_TRANSCRIBE_CHUNKS).toBeGreaterThan(
      planMediaChunks(25 * 1024 * 1024).length,
    );
  });

  it("names the failing chunk and never pretends the transcript is whole", async () => {
    let calls = 0;
    const out = await transcribeMedia(
      async () => {
        calls++;
        if (calls === 2) throw new Error("model exploded");
        return { text: `part${calls}` };
      },
      new Uint8Array(TRANSCRIBE_CHUNK_BYTES * 2 + 1),
      { chunkBytes: 1024, overlapBytes: 64, maxChunks: 10_000 },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/chunk 2/i);
    expect(out.reason).toMatch(/model exploded/);
  });

  it("rejects a malformed model reply rather than mirroring an empty frame", async () => {
    const out = await transcribeMedia(async () => ({}), new Uint8Array(64));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/no text/i);
  });
});

describe("transcription route (C6)", () => {
  async function setup(extra: Record<string, unknown> = {}) {
    const { default: app } = await import("../src/index");
    const { FakeD1 } = await import("./helpers/d1");
    const { FakeR2 } = await import("./helpers/r2");
    const db = new FakeD1();
    const corpus = new FakeR2();
    const env = makeEnv({ DB: db as never, CORPUS: corpus as never, ...extra });
    const callApp = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://survey.example${path}`, init), env as never);
    return { env, db, corpus, callApp };
  }

  it("transcribes a recording end to end, gated before the mirror", async () => {
    const { db, corpus, callApp } = await setup({
      AI: {
        run: async () => ({ text: "Zara Kline approved the roster" }),
      },
    });
    const up = (await (
      await callApp("/api/corpus", {
        method: "POST",
        headers: mediaHeaders("interview.mp3", "audio/mpeg"),
        body: "fake-mp3-bytes",
      })
    ).json()) as { id: string; lane: string; status: string };
    expect(up.lane).toBe("held-audio");
    expect(up.status).toBe("held");

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
    ).json()) as { docs: Array<{ status: string; verdict: string; reason: string | null }> };
    expect(list.docs[0].status).toBe("transcribed");
    expect(list.docs[0].verdict).toBe("gated");
    expect(list.docs[0].reason).toBeNull();

    // The mirror holds the gated transcript; the name is sealed, raw deleted.
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("roster");
    expect(fts).not.toContain("Zara Kline");
    const entities = JSON.stringify(await db.prepare("SELECT * FROM entities").all());
    expect(entities).not.toContain("Zara Kline");
    expect(corpus.keys()).toEqual([]);
    const tele = (await (
      await callApp("/api/telemetry", { headers: auth })
    ).json()) as Array<{ outcome: string | null }>;
    expect(tele.some((t) => t.outcome === "transcribed")).toBe(true);
  });

  it("chunks long media through the lane and mirrors one ordered transcript", async () => {
    const calls: number[] = [];
    const { db, callApp } = await setup({
      AI: {
        run: async (_model: string, inputs: Record<string, unknown>) => {
          calls.push(String(inputs.audio).length);
          return { text: ["alpha beta", "beta gamma", "gamma delta"][calls.length - 1] ?? "" };
        },
      },
    });
    // Over two default chunks: three model calls with the overlap window.
    await callApp("/api/corpus", {
      method: "POST",
      headers: mediaHeaders("long-meeting.mp4", "video/mp4"),
      body: new Uint8Array(TRANSCRIBE_CHUNK_BYTES * 2 + 4096),
    });
    const out = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number };
    expect(out.drained).toBe(1);
    expect(calls.length).toBe(3);
    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("alpha beta gamma delta");
    const list = (await (
      await callApp("/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ status: string }> };
    expect(list.docs[0].status).toBe("transcribed");
  });

  it("stays held with an actionable reason when Workers AI is absent", async () => {
    const { corpus, callApp } = await setup();
    await callApp("/api/corpus", {
      method: "POST",
      headers: mediaHeaders("interview.mp3", "audio/mpeg"),
      body: "fake-mp3-bytes",
    });
    const out = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number; outcomes: Array<{ reason: string | null }> };
    expect(out.drained).toBe(0);
    expect(out.outcomes[0].reason).toMatch(/held-audio/);
    expect(out.outcomes[0].reason).toMatch(/Workers AI/i);
    // The raw bytes stay held for the retry window.
    expect(corpus.keys().length).toBe(1);
  });

  it("stays held and names the failed chunk when the model errors", async () => {
    const { callApp } = await setup({
      AI: {
        run: async () => {
          throw new Error("binding unavailable");
        },
      },
    });
    await callApp("/api/corpus", {
      method: "POST",
      headers: mediaHeaders("interview.wav", "audio/wav"),
      body: "fake-wav-bytes",
    });
    const out = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { outcomes: Array<{ reason: string | null }> };
    expect(out.outcomes[0].reason).toMatch(/chunk 1 of 1/);
    expect(out.outcomes[0].reason).toMatch(/binding unavailable/);
  });
});
