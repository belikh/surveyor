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

describe("launch pack routes", () => {
  it("401s pack generation without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/launch-pack");
    expect(res.status).toBe(401);
  });

  it("generates all seven assets with a bare-URL QR payload", async () => {
    const env = makeEnv();
    const pack = (await (
      await callApp(env, "/api/launch-pack", { headers: auth })
    ).json()) as Record<string, string>;
    for (const k of [
      "submissions_url",
      "qr_square_svg",
      "qr_story_svg",
      "copy_short",
      "copy_long",
      "copy_dm",
      "alt_text",
    ]) {
      expect(pack[k], k).toBeTruthy();
    }
    // Bare URL: no query, no fragment.
    expect(pack.submissions_url).not.toMatch(/[?#]/);
    // QR SVGs are real SVG documents encoding the same bare URL.
    expect(pack.qr_square_svg).toContain("<svg");
    expect(pack.qr_story_svg).toContain("<svg");
    // Story asset is a portrait canvas; square is square.
    expect(pack.qr_story_svg).toContain('viewBox="0 0 360 640"');
    // QR is payload-bound: a different slug encodes a different code.
    const p2 = (await (
      await callApp(env, "/api/launch-pack/rotate", {
        method: "POST",
        headers: auth,
      })
    ).json()) as Record<string, string>;
    expect(p2.qr_square_svg).not.toBe(pack.qr_square_svg);
    // Copy carries the URL and stays anonymity-first.
    expect(pack.copy_short).toContain(pack.submissions_url);
    expect(pack.copy_short).toMatch(/no tracking/i);
  });

  it("rotation invalidates the old slug and serves the new one", async () => {
    const env = makeEnv();
    const p1 = (await (
      await callApp(env, "/api/launch-pack", { headers: auth })
    ).json()) as Record<string, string>;
    const rotated = (await (
      await callApp(env, "/api/launch-pack/rotate", {
        method: "POST",
        headers: auth,
      })
    ).json()) as Record<string, string>;
    expect(rotated.submissions_url).not.toBe(p1.submissions_url);
    const oldSlug = p1.submissions_url.split("/s/")[1];
    const newSlug = rotated.submissions_url.split("/s/")[1];
    expect(
      (await callApp(env, `/s/${oldSlug}`)).status,
    ).toBe(404);
    const live = await callApp(env, `/s/${newSlug}`);
    expect(live.status).toBe(200);
    expect(await live.text()).toContain("anonymous survey");
    // Rotated pack wording stays anonymity-first.
    expect(rotated.copy_short).toMatch(/no tracking/i);
    expect(rotated.copy_long).toContain(rotated.submissions_url);
  });
});

describe("launch pack audit wiring", () => {
  it("rejects generation when caller terms match the pack", async () => {
    const env = makeEnv();
    const res = await callApp(
      env,
      "/api/launch-pack?forbidden=anonymous",
      { headers: auth },
    );
    // "anonymous" appears throughout our own copy: the identity leg is live.
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("pack_failed_audit");
  });
});
