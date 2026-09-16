import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: "op-token",
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

describe("survey shell", () => {
  it("serves with security headers", async () => {
    const res = await callApp(makeEnv(), "/survey");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain("/survey.js");
    expect(html).toContain('lang="en-AU"');
  });

  it("survey.js parses clean with no innerHTML anywhere", async () => {
    const res = await callApp(makeEnv(), "/survey.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(() => new Script(js)).not.toThrow();
    expect(js).not.toContain("innerHTML");
    expect(js).not.toContain("outerHTML");
  });

  it("driver wires the full intake API surface", async () => {
    const res = await callApp(makeEnv(), "/survey.js");
    const js = await res.text();
    for (const endpoint of [
      "/api/intake/challenge",
      "/api/intake\"",
      "/steps",
      "/resume",
      "/rounds",
      "/addendum",
    ]) {
      expect(js, endpoint).toContain(endpoint);
    }
  });

  it("shell renders instrument consent copy from setup state", async () => {    const env = makeEnv();
    const TOKEN = "op-token";
    const auth = {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    };
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        kind: "instrument",
        title: "Journey Survey",
        blurb: "Tell us",
        consent: "CONSENT-MARKER-77",
      }),
    });
    const res = await callApp(env, "/survey");
    const html = await res.text();
    expect(html).toContain("Journey Survey");
    expect(html).toContain("CONSENT-MARKER-77");
  });
});

describe("survey hardening", () => {
  it("renders hostile instrument copy inert (no script breakout)", async () => {
    const env = makeEnv();
    const TOKEN = "op-token";
    const auth = {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    };
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        kind: "instrument",
        title: 'T</title><script>alert(1)</script>',
        blurb: "B",
        consent: 'C</script><script>alert(2)</script>',
      }),
    });
    const html = await (await callApp(env, "/survey")).text();
    // Exactly one script tag (the driver) and one style block; the
    // payload survives only as escaped attribute text.
    expect(html.match(/<script/g)?.length ?? 0).toBe(1);
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("&lt;/script&gt;");
  });
});
