import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { FakeR2 } from "./helpers/r2";

const TOKEN = "op-token";
const auth = { authorization: `Bearer ${TOKEN}` };

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
    new Request(`https://surveyor.example${path}`, init),
    env as never,
  );
}

/** A11/A15 corpus framing: identifiers travel in headers, never the request
 *  line, and the bytes are the raw body — not a base64 JSON field. */
async function upload(
  env: Record<string, unknown>,
  filename: string,
  mediaType: string,
  body: BodyInit,
) {
  return callApp(env, "/api/corpus", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-filename": encodeURIComponent(filename),
      "content-type": mediaType,
    },
    body,
  });
}

/** Chunked framing: the stream carries no content-length, and the route must
 *  read it through the body stream, never `arrayBuffer()` — that is the
 *  buffering seam. */
async function streamedUpload(
  env: Record<string, unknown>,
  filename: string,
  mediaType: string,
  chunks: Uint8Array[],
) {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  const req = new Request("https://surveyor.example/api/corpus", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-filename": encodeURIComponent(filename),
      "content-type": mediaType,
    },
    body,
    duplex: "half",
  } as RequestInit);
  Object.defineProperty(req, "arrayBuffer", {
    value: () => {
      throw new Error("request body was buffered");
    },
  });
  return app.fetch(req, env as never);
}

class RecordingR2 extends FakeR2 {
  streamed: boolean[] = [];
  override async put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  ): Promise<void> {
    this.streamed.push(value instanceof ReadableStream);
    return super.put(key, value);
  }
}

describe("corpus routes", () => {
  it("401s uploads without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/corpus", {
      method: "POST",
      headers: { "x-filename": "a.txt", "content-type": "text/plain" },
      body: "hi",
    });
    expect(res.status).toBe(401);
  });

  it("ingests a text document end to end with gated status", async () => {
    const env = makeEnv();
    const up = (await (
      await upload(env, "notes.txt", "text/plain", "Rosters are posted on Tuesdays")
    ).json()) as Record<string, string>;
    expect(up.id).toBeTruthy();
    expect(up.lane).toBe("native");
    expect(up.verdict).toBe("clean");

    const list = (await (
      await callApp(env, "/api/corpus", { headers: auth })
    ).json()) as { docs: Array<Record<string, string>> };
    expect(list.docs.map((d) => d.filename)).toContain("notes.txt");
    expect(list.docs[0].status).toBe("parsed");
  });

  it("holds scans for the model pass and rejects hostile uploads loudly", async () => {
    const env = makeEnv();
    const held = (await (
      await upload(env, "scan.png", "image/png", "fakepng")
    ).json()) as Record<string, string>;
    expect(held.lane).toBe("held-ocr");
    expect(held.status).toBe("held");
    expect(held.verdict).toBe("pending");

    const bad = await upload(env, "evil.exe", "application/octet-stream", "MZ");
    expect(bad.status).toBe(422);
  });

  it("mirror text never contains quarantined names", async () => {
    const env = makeEnv();
    await upload(env, "minutes.txt", "text/plain", "Zara Kline approved the roster");
    const db = env.DB as FakeD1;
    const dump = JSON.stringify(
      await db.prepare("SELECT * FROM corpus_docs").all(),
    );
    expect(dump).not.toContain("Zara Kline");
    // Gated mirror: scrubbed text searchable, names absent.
    const fts = JSON.stringify(
      await db.prepare("SELECT * FROM corpus_fts").all(),
    );
    expect(fts).toContain("roster");
    expect(fts).not.toContain("Zara Kline");
  });

  it("rejects the retired base64 JSON framing", async () => {
    const env = makeEnv();
    const res = await callApp(env, "/api/corpus", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: "notes.txt",
        content_type: "text/plain",
        content_b64: Buffer.from("hi").toString("base64"),
      }),
    });
    expect(res.status).toBe(422);
  });

  it("decodes a chunked native upload without buffering and mirrors the text", async () => {
    const env = makeEnv();
    const chunks = [
      new TextEncoder().encode("Rosters are "),
      new TextEncoder().encode("posted on "),
      new TextEncoder().encode("Tuesdays"),
    ];
    const res = await streamedUpload(env, "notes.txt", "text/plain", chunks);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lane: string;
      status: string;
      verdict: string;
    };
    expect(body.lane).toBe("native");
    expect(body.status).toBe("parsed");
    expect(body.verdict).toBe("clean");
    const fts = JSON.stringify(
      await (env.DB as FakeD1).prepare("SELECT * FROM corpus_fts").all(),
    );
    expect(fts).toContain("Rosters are posted on Tuesdays");
  });

  it("streams a twenty-five megabyte scan into R2 without buffering the body", async () => {
    const r2 = new RecordingR2();
    const sent: Array<Record<string, unknown>> = [];
    const env = makeEnv({
      CORPUS: r2 as never,
      INGEST: {
        send: async (message: Record<string, unknown>) => {
          sent.push(message);
        },
      } as never,
    });
    const chunks = Array.from({ length: 25 }, () => new Uint8Array(1024 * 1024));
    const res = await streamedUpload(env, "big-scan.png", "image/png", chunks);
    expect(res.status).toBe(200);
    // The object store received a stream, not an arrayBuffer: the 25 MB body
    // never sat in isolate memory.
    expect(r2.streamed).toEqual([true]);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("held");
    const row = (await (env.DB as FakeD1)
      .prepare("SELECT raw_key FROM corpus_docs")
      .first()) as { raw_key: string };
    expect(r2.has(row.raw_key)).toBe(true);
    // The held doc is still enqueued for the model pass.
    expect(sent).toEqual([{ doc_id: body.id, lane: "held-ocr" }]);
  });

  it("refuses an over-cap stream and leaves no object behind", async () => {
    const r2 = new RecordingR2();
    const env = makeEnv({ CORPUS: r2 as never });
    const chunks = Array.from({ length: 25 }, () => new Uint8Array(1024 * 1024));
    chunks.push(new Uint8Array([1]));
    const res = await streamedUpload(env, "bigger.png", "image/png", chunks);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("rejected");
    expect(r2.keys()).toEqual([]);
  });

  it("rejects an empty stream", async () => {
    const r2 = new RecordingR2();
    const env = makeEnv({ CORPUS: r2 as never });
    const res = await streamedUpload(env, "empty.txt", "text/plain", []);
    expect(res.status).toBe(422);
    expect(r2.keys()).toEqual([]);
  });
});
