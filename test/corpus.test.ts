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
    new Request(`https://surveyor.example${path}`, init),
    env as never,
  );
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

describe("corpus routes", () => {
  it("401s uploads without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/corpus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "a.txt",
        content_type: "text/plain",
        content_b64: b64("hi"),
      }),
    });
    expect(res.status).toBe(401);
  });

  it("ingests a text document end to end with gated status", async () => {
    const env = makeEnv();
    const up = (await (
      await callApp(env, "/api/corpus", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          filename: "notes.txt",
          content_type: "text/plain",
          content_b64: b64("Rosters are posted on Tuesdays"),
        }),
      })
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
      await callApp(env, "/api/corpus", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          filename: "scan.png",
          content_type: "image/png",
          content_b64: b64("fakepng"),
        }),
      })
    ).json()) as Record<string, string>;
    expect(held.lane).toBe("held-ocr");
    expect(held.status).toBe("held");
    expect(held.verdict).toBe("pending");

    const bad = await callApp(env, "/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "evil.exe",
        content_type: "application/octet-stream",
        content_b64: b64("MZ"),
      }),
    });
    expect(bad.status).toBe(422);
  });

  it("mirror text never contains quarantined names", async () => {
    const env = makeEnv();
    await callApp(env, "/api/corpus", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        filename: "minutes.txt",
        content_type: "text/plain",
        content_b64: b64("Zara Kline approved the roster"),
      }),
    });
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
});
