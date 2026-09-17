import { describe, it, expect, vi, afterEach } from "vitest";
import { Script } from "node:vm";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { solveChallenge } from "../src/lib/pow";

const TOKEN = "op-token";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    POW_DIFFICULTY: "8",
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

async function solvedPow(env: Record<string, unknown>) {
  const ch = (await (
    await callApp(env, "/api/intake/challenge")
  ).json()) as { challenge: string; difficulty: number };
  const nonce = await solveChallenge(ch.challenge, ch.difficulty);
  return { challenge: ch.challenge, nonce: String(nonce) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Turnstile gate", () => {
  it("accepts a valid token, forwarding only secret + response", async () => {
    let sentBody = "";
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls++;
      sentBody = String(init.body);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const env = {
      ...makeEnv(),
      TURNSTILE_SECRET: "ts-secret",
      TURNSTILE_SITEKEY: "1x00000000000000000000AA",
    };
    const pow = await solvedPow(env);
    const res = await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ pow, turnstile_token: "tok-abc" }),
    });
    expect(res.status).toBe(201);
    expect(calls).toBe(1);
    expect(sentBody).toContain("secret=ts-secret");
    expect(sentBody).toContain("response=tok-abc");
    // No identity signals: secret + token only.
    expect(sentBody).not.toContain("remoteip");
    expect(sentBody).not.toContain("ip=");
  });

  it("fails closed when siteverify rejects the token", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ success: false }), { status: 200 }),
    );
    const env = { ...makeEnv(), TURNSTILE_SECRET: "ts-secret" };
    const pow = await solvedPow(env);
    const res = await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ pow, turnstile_token: "tok-abc" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "turnstile_failed",
    );
  });

  it("fails closed on a missing token without calling siteverify", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const env = { ...makeEnv(), TURNSTILE_SECRET: "ts-secret" };
    const pow = await solvedPow(env);
    const res = await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ pow }),
    });
    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });

  it("is absent with no secret (gate-off behaviour unchanged)", async () => {
    const env = makeEnv();
    const pow = await solvedPow(env);
    const res = await callApp(env, "/api/intake", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ pow }),
    });
    expect(res.status).toBe(201);
  });
});

describe("Turnstile configuration surface", () => {
  it("exposes the sitekey only while the secret is set", async () => {
    const off = (await (
      await callApp(makeEnv(), "/api/status")
    ).json()) as Record<string, unknown>;
    expect(off.turnstile_sitekey).toBeUndefined();
    expect(Object.keys(off).sort()).toEqual([
      "degraded",
      "provisioned",
      "warning",
    ]);

    const on = (await (
      await callApp(
        {
          ...makeEnv(),
          TURNSTILE_SECRET: "ts-secret",
          TURNSTILE_SITEKEY: "site-1",
        },
        "/api/status",
      )
    ).json()) as Record<string, unknown>;
    expect(on.turnstile_sitekey).toBe("site-1");
  });

  it("does not expose a sitekey when the secret is set but the sitekey is empty", async () => {
    const body = (await (
      await callApp({ ...makeEnv(), TURNSTILE_SECRET: "ts-secret" }, "/api/status")
    ).json()) as Record<string, unknown>;
    expect(body.turnstile_sitekey).toBeUndefined();
  });

  it("extends the CSP only while the gate is enabled", async () => {
    const off = await callApp(makeEnv(), "/survey");
    const offCsp = off.headers.get("content-security-policy") ?? "";
    expect(offCsp).toContain("default-src 'none'");
    expect(offCsp).not.toContain("challenges.cloudflare.com");

    const on = await callApp(
      { ...makeEnv(), TURNSTILE_SECRET: "ts-secret" },
      "/survey",
    );
    const onCsp = on.headers.get("content-security-policy") ?? "";
    expect(onCsp).toContain(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(onCsp).toContain("frame-src https://challenges.cloudflare.com");
  });

  it("wires the widget token into the survey driver", async () => {
    const js = await (await callApp(makeEnv(), "/survey.js")).text();
    expect(js).toContain("challenges.cloudflare.com");
    expect(js).toContain("turnstile_token");
    expect(js).toContain("turnstile_sitekey");
    expect(js).toContain("turnstile.execute");
    expect(js).not.toContain("innerHTML");
    expect(() => new Script(js)).not.toThrow();
  });
});
