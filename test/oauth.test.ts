import { describe, it, expect, vi, afterEach } from "vitest";
import { Script } from "node:vm";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

function makeEnv(over: Record<string, unknown> = {}) {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: "op-token",
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    ...over,
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

const configured = () =>
  makeEnv({
    CF_OAUTH_CLIENT_ID: "client-123",
    CF_OAUTH_AUTHORIZE_URL: "https://cf.example/authorize",
    CF_OAUTH_TOKEN_URL: "https://cf.example/token",
    CF_OAUTH_SCOPES: "workers-scripts.write",
    CF_OAUTH_CLIENT_SECRET: "client-secret-xyz",
  });

async function stateFromStart(env: Record<string, unknown>): Promise<string> {
  const res = await callApp(env, "/api/oauth/start");
  const loc = res.headers.get("location") ?? "";
  return new URL(loc).searchParams.get("state") ?? "";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth consent (R2)", () => {
  it("404s the start route when no client is configured", async () => {
    const res = await callApp(makeEnv(), "/api/oauth/start");
    expect(res.status).toBe(404);
  });

  it("redirects to the authorize endpoint with a signed state", async () => {
    const res = await callApp(configured(), "/api/oauth/start");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    const u = new URL(loc);
    expect(u.origin + u.pathname).toBe("https://cf.example/authorize");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://surveyor.example/api/oauth/callback",
    );
    expect(u.searchParams.get("scope")).toBe("workers-scripts.write");
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  it("rejects a tampered state", async () => {
    const env = configured();
    await stateFromStart(env);
    const res = await callApp(
      env,
      "/api/oauth/callback?code=abc&state=123.forged",
    );
    expect(res.status).toBe(400);
  });

  it("exchanges the code and returns the token in the fragment only", async () => {
    const env = configured();
    const state = await stateFromStart(env);
    let sentBody = "";
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("https://cf.example/token");
      sentBody = String(init.body);
      return new Response(JSON.stringify({ access_token: "at-123" }), {
        status: 200,
      });
    });
    const res = await callApp(
      env,
      `/api/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#cf_token=at-123");
    expect(sentBody).toContain("code=abc");
    expect(sentBody).toContain("client_id=client-123");
    // The token never appears in a persisted row.
    const db = env.DB as FakeD1;
    const dump = JSON.stringify([
      await db.prepare("SELECT * FROM setup_state").all(),
      await db.prepare("SELECT * FROM audit").all(),
    ]);
    expect(dump).not.toContain("at-123");
  });

  it("fails loud on a token-endpoint error without echoing the body", async () => {
    const env = configured();
    const state = await stateFromStart(env);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("access_token=leaked-in-error", { status: 401 }),
    );
    const res = await callApp(
      env,
      `/api/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toMatch(/HTTP 401/);
    expect(text).not.toContain("leaked-in-error");
  });
});

describe("wizard key-entry wiring", () => {
  it("parses and wires token, OAuth, and key entry", async () => {
    const res = await callApp(makeEnv(), "/wizard.js");
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(() => new Script(js)).not.toThrow();
    expect(js).not.toContain("innerHTML");
    for (const needle of [
      "/api/providers/key",
      "/api/oauth/start",
      "authorization",
      "cf_token",
      "api_key",
    ]) {
      expect(js, needle).toContain(needle);
    }
  });
});
