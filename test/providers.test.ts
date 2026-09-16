import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

const TOKEN = "op-token";

function makeEnv(secrets: Record<string, string> = {}) {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    ...secrets,
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

async function setupWithProviders(
  env: Record<string, unknown>,
  providers: unknown[],
) {
  const auth = {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  };
  await callApp(env, "/api/setup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ kind: "providers", providers }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/providers", () => {
  it("401s without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/providers");
    expect(res.status).toBe(401);
  });
  it("reports degraded with a dashboard warning when keyless", async () => {
    const env = makeEnv();
    await setupWithProviders(env, []);
    const res = await callApp(env, "/api/providers", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.degraded).toBe(true);
    expect(body.warning).toMatch(/static fallback/i);
    expect(body.entries).toEqual([]);
  });

  it("resolves the operator-ordered chain from present secrets", async () => {
    const env = makeEnv({ B_KEY: "s3cr3t" });
    await setupWithProviders(env, [
      { kind: "groq", label: "g", secret_slot: "A_KEY", model: "m" },
      {
        kind: "openai-compatible",
        label: "c",
        secret_slot: "B_KEY",
        model: "m",
        base_url: "https://llm.example/v1",
      },
    ]);
    const body = (await (
      await callApp(env, "/api/providers", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as Record<string, unknown>;
    expect(body.degraded).toBe(false);
    expect(body.warning).toBeNull();
    expect(
      (body.entries as Array<Record<string, string>>).map((e) => e.label),
    ).toEqual(["c"]);
  });

  it("never exposes secret values in the chain response", async () => {
    const env = makeEnv({ B_KEY: "s3cr3t-value-xyz" });
    await setupWithProviders(env, [
      { kind: "groq", label: "g", secret_slot: "B_KEY", model: "m" },
    ]);
    const text = await (
      await callApp(env, "/api/providers", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).text();
    expect(text).not.toContain("s3cr3t-value-xyz");
  });
});

describe("GET /api/status", () => {
  it("is public and carries booleans plus warning copy only", async () => {
    const env = makeEnv();
    await setupWithProviders(env, []);
    const body = (await (
      await callApp(env, "/api/status")
    ).json()) as Record<string, unknown>;
    expect(body.degraded).toBe(true);
    expect(body.warning).toMatch(/static fallback/i);
    expect(Object.keys(body).sort()).toEqual(["degraded", "warning"]);
  });
});

describe("save-time validation wired into POST /api/setup", () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    kind: "providers",
    providers: [
      {
        kind: "openai-compatible",
        label: "c",
        secret_slot: "C_KEY",
        model: "m",
        base_url: "https://llm.example/v1",
        apiKey: "k",
        ...over,
      },
    ],
  });

  it("validates a custom draft on save and strips the key before persist", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const env = makeEnv();
    const res = await callApp(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(draft()),
    });
    expect(res.status).toBe(200);
    const saved = (await (
      await callApp(env, "/api/setup")
    ).json()) as Record<string, unknown>;
    const text = JSON.stringify(saved);
    expect(text).not.toContain('"apiKey"');
    expect(text).toContain("C_KEY");
  });

  it("422s loudly when the custom draft fails its test call", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("nope", { status: 403 }),
    );
    const env = makeEnv();
    const res = await callApp(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(draft()),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_invalid");
    expect(String(body.detail)).toMatch(/403/);
    // Nothing persisted: still in welcome.
    const saved = (await (
      await callApp(env, "/api/setup")
    ).json()) as Record<string, unknown>;
    expect(saved.phase).toBe("welcome");
  });
});

describe("POST /api/providers/validate", () => {
  const draftBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      label: "c",
      baseUrl: "https://llm.example/v1",
      model: "m",
      apiKey: "k",
      ...over,
    });
  const authed = {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  };
  it("401s without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: draftBody(),
    });
    expect(res.status).toBe(401);
  });

  it("passes a live custom provider and persists nothing", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/validate", {
      method: "POST",
      headers: authed,
      body: draftBody(),
    });
    expect(await res.json()).toEqual({ ok: true });
    // Nothing persisted: chain still degraded.
    const chain = (await (
      await callApp(env, "/api/providers", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as Record<string, unknown>;
    expect(chain.degraded).toBe(true);
  });

  it("fails loud on 401 without echoing the key", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("nope", { status: 401 }),
    );
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/validate", {
      method: "POST",
      headers: authed,
      body: draftBody({ apiKey: "sk-live-secret" }),
    });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toMatch(/401/);
    expect(text).not.toContain("sk-live-secret");
  });
});
