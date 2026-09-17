import { describe, it, expect, vi, afterEach } from "vitest";
import { Script } from "node:vm";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { codeChallengeS256, generateCodeVerifier } from "../src/lib/oauth";

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
  });

/** Start the flow: the redirect carries state + challenge, and the verifier
 *  comes back in the HttpOnly cookie the callback will read. */
async function startFlow(env: Record<string, unknown>) {
  const res = await callApp(env, "/api/oauth/start");
  const location = new URL(res.headers.get("location") ?? "");
  const setCookie = res.headers.get("set-cookie") ?? "";
  const verifier =
    /surveyor_oauth_verifier=([^;]*)/.exec(setCookie)?.[1] ?? "";
  return {
    location,
    state: location.searchParams.get("state") ?? "",
    challenge: location.searchParams.get("code_challenge") ?? "",
    setCookie,
    verifier,
    cookie: setCookie.split(";")[0],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PKCE (A4, ADR-0013)", () => {
  it("derives the RFC 7636 Appendix B S256 challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await codeChallengeS256(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates 43-character verifiers from the unreserved set", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCodeVerifier()).not.toBe(verifier);
  });
});

describe("OAuth consent (R2)", () => {
  it("404s the start route when no client is configured", async () => {
    const res = await callApp(makeEnv(), "/api/oauth/start");
    expect(res.status).toBe(404);
  });

  it("redirects with a signed state and an S256 challenge", async () => {
    const flow = await startFlow(configured());
    const u = flow.location;
    expect(u.origin + u.pathname).toBe("https://cf.example/authorize");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://surveyor.example/api/oauth/callback",
    );
    expect(u.searchParams.get("scope")).toBe("workers-scripts.write");
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    // The challenge is the verifier's digest, and the verifier is held in
    // an HttpOnly cookie scoped to the callback path.
    expect(flow.challenge).toBe(await codeChallengeS256(flow.verifier));
    expect(flow.setCookie).toMatch(/HttpOnly/);
    expect(flow.setCookie).toMatch(/Path=\/api\/oauth/);
    expect(flow.setCookie).toMatch(/SameSite=Lax/);
  });

  it("rejects a tampered state", async () => {
    const env = configured();
    const flow = await startFlow(env);
    const res = await callApp(
      env,
      "/api/oauth/callback?code=abc&state=123.forged",
      { headers: { cookie: flow.cookie } },
    );
    expect(res.status).toBe(400);
  });

  it("refuses a callback that carries no verifier cookie", async () => {
    const env = configured();
    const flow = await startFlow(env);
    const res = await callApp(
      env,
      `/api/oauth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_code_verifier",
    );
  });

  it("exchanges the code with the verifier, no client secret, fragment only", async () => {
    const env = configured();
    const flow = await startFlow(env);
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
      `/api/oauth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      { headers: { cookie: flow.cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#cf_token=at-123");
    expect(sentBody).toContain("code=abc");
    expect(sentBody).toContain("client_id=client-123");
    expect(sentBody).toContain(`code_verifier=${flow.verifier}`);
    expect(sentBody).not.toContain("client_secret");
    // The verifier cookie is cleared once spent.
    expect(res.headers.get("set-cookie") ?? "").toMatch(/Max-Age=0/);
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
    const flow = await startFlow(env);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("access_token=leaked-in-error", { status: 401 }),
    );
    const res = await callApp(
      env,
      `/api/oauth/callback?code=abc&state=${encodeURIComponent(flow.state)}`,
      { headers: { cookie: flow.cookie } },
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
