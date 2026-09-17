import { describe, it, expect, vi, afterEach } from "vitest";
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

/** Stub the two outbound calls this path makes: the provider test call
 *  (`GET /models`) and the Cloudflare secret API. Capture what was sent. */
function stubCloudflare({ validateOk = true } = {}) {
  const calls = { validate: 0, puts: [] as string[], deletes: [] as string[] };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/models")) {
      calls.validate++;
      return validateOk
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response("no", { status: 401 });
    }
    if (u.includes("/workers/scripts/") && u.includes("/secrets")) {
      if (init?.method === "DELETE") calls.deletes.push(u);
      else calls.puts.push(String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

function entryBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    cf_token: "cf-secret-token",
    account_id: "acct-123",
    script_name: "surveyor",
    kind: "openai-compatible",
    label: "c",
    model: "m",
    base_url: "https://llm.example/v1",
    secret_slot: "GROQ_API_KEY",
    api_key: "sk-live-secret-xyz",
    ...over,
  });
}

async function providersInState(env: Record<string, unknown>) {
  const state = (await (
    await callApp(env, "/api/setup", { headers: auth })
  ).json()) as {
    providers: Array<Record<string, string>>;
  };
  return state.providers;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BYOK key entry (R2)", () => {
  it("validates, writes the secret, and persists the slot name only", async () => {
    const calls = stubCloudflare();
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: entryBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slot: "GROQ_API_KEY" });
    expect(calls.validate).toBe(1);
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0]).toContain("GROQ_API_KEY");
    expect(calls.puts[0]).toContain("sk-live-secret-xyz");

    const providers = await providersInState(env);
    expect(providers.map((p) => p.secret_slot)).toEqual(["GROQ_API_KEY"]);
    expect(providers[0].label).toBe("c");
    expect(providers[0].base_url).toBe("https://llm.example/v1");
  });

  it("never persists the key or the Cloudflare token anywhere", async () => {
    stubCloudflare();
    const env = makeEnv();
    await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: entryBody(),
    });
    const db = env.DB as FakeD1;
    const dump = JSON.stringify([
      await db.prepare("SELECT * FROM setup_state").all(),
      await db.prepare("SELECT * FROM audit").all(),
      await db.prepare("SELECT * FROM telemetry").all(),
    ]);
    expect(dump).not.toContain("sk-live-secret-xyz");
    expect(dump).not.toContain("cf-secret-token");
    expect(dump).toContain("GROQ_API_KEY");
  });

  it("rotates in place when the same slot is written again", async () => {
    const calls = stubCloudflare();
    const env = makeEnv();
    await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: entryBody(),
    });
    await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: entryBody({ label: "c2", api_key: "sk-second-key" }),
    });
    expect(calls.puts).toHaveLength(2);
    const providers = await providersInState(env);
    expect(providers).toHaveLength(1);
    expect(providers[0].label).toBe("c2");
    const dump = JSON.stringify(await (env.DB as FakeD1).prepare("SELECT * FROM setup_state").all());
    expect(dump).not.toContain("sk-second-key");
  });

  it("removes the key and the entry", async () => {
    const calls = stubCloudflare();
    const env = makeEnv();
    await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: entryBody(),
    });
    const res = await callApp(env, "/api/providers/key/GROQ_API_KEY", {
      method: "DELETE",
      headers: auth,
      body: JSON.stringify({
        cf_token: "cf-secret-token",
        account_id: "acct-123",
        script_name: "surveyor",
      }),
    });
    expect(res.status).toBe(200);
    expect(calls.deletes).toHaveLength(1);
    expect(await providersInState(env)).toEqual([]);
  });

  it("does not store anything when the key fails its test call", async () => {
    const calls = stubCloudflare({ validateOk: false });
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: entryBody(),
    });
    expect(res.status).toBe(422);
    expect(calls.puts).toHaveLength(0);
    expect(await providersInState(env)).toEqual([]);
  });

  it("rejects a malformed secret slot name", async () => {
    stubCloudflare();
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: entryBody({ secret_slot: "../escape" }),
    });
    expect(res.status).toBe(422);
  });

  it("refuses to delete non-provider slots", async () => {
    const calls = stubCloudflare();
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/key/ENCRYPTION_KEY", {
      method: "DELETE",
      headers: auth,
      body: JSON.stringify({
        cf_token: "cf-secret-token",
        account_id: "acct-123",
        script_name: "surveyor",
      }),
    });
    expect(res.status).toBe(404);
    expect(calls.deletes).toHaveLength(0);
  });

  it("requires the operator token", async () => {
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: entryBody(),
    });
    expect(res.status).toBe(401);
  });
});
