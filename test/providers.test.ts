import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { hasSecretValue, secretValue } from "../src/lib/providers";
import { FakeD1 } from "./helpers/d1";

const TOKEN = "op-token";

function makeEnv(secrets: Record<string, string> = {}) {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
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
    const env = makeEnv({ TOKENROUTER_API_KEY: "s3cr3t" });
    await setupWithProviders(env, [
      { kind: "groq", label: "g", secret_slot: "GROQ_API_KEY", model: "m" },
      {
        kind: "openai-compatible",
        label: "c",
        secret_slot: "TOKENROUTER_API_KEY",
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

  it("stores and resolves more than two entries in operator order", async () => {
    const env = makeEnv({
      GROQ_API_KEY: "a",
      TOKENROUTER_API_KEY: "b",
      TAVILY_API_KEY: "c",
      PARALLEL_API_KEY: "d",
    });
    await setupWithProviders(env, [
      { kind: "groq", label: "g", secret_slot: "GROQ_API_KEY", model: "m" },
      {
        kind: "tokenrouter",
        label: "t",
        secret_slot: "TOKENROUTER_API_KEY",
        model: "m",
      },
      {
        kind: "tavily",
        label: "tv",
        secret_slot: "TAVILY_API_KEY",
        model: "search",
        capabilities: ["search"],
      },
      {
        kind: "parallel",
        label: "pl",
        secret_slot: "PARALLEL_API_KEY",
        model: "search",
        capabilities: ["search"],
      },
    ]);
    const body = (await (
      await callApp(env, "/api/providers", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { entries: Array<{ label: string }> };
    expect(body.entries.map((e) => e.label)).toEqual(["g", "t", "tv", "pl"]);
  });

  it("never exposes secret values in the chain response", async () => {
    const env = makeEnv({ TOKENROUTER_API_KEY: "s3cr3t-value-xyz" });
    await setupWithProviders(env, [
      { kind: "groq", label: "g", secret_slot: "TOKENROUTER_API_KEY", model: "m" },
    ]);
    const text = await (
      await callApp(env, "/api/providers", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).text();
    expect(text).not.toContain("s3cr3t-value-xyz");
  });
});

describe("POST /api/providers/reorder", () => {
  const twoEntries = [
    { kind: "groq", label: "g", secret_slot: "GROQ_API_KEY", model: "m" },
    {
      kind: "tokenrouter",
      label: "t",
      secret_slot: "TOKENROUTER_API_KEY",
      model: "m",
    },
  ];

  it("401s without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/providers/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: 0, to: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("persists the new operator-visible order", async () => {
    const env = makeEnv({ GROQ_API_KEY: "a", TOKENROUTER_API_KEY: "b" });
    await setupWithProviders(env, twoEntries);
    const res = await callApp(env, "/api/providers/reorder", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ from: 0, to: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await (
      await callApp(env, "/api/providers", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { entries: Array<{ label: string }> };
    expect(body.entries.map((e) => e.label)).toEqual(["t", "g"]);
  });

  it("422s an out-of-range move and leaves the order untouched", async () => {
    const env = makeEnv({ GROQ_API_KEY: "a", TOKENROUTER_API_KEY: "b" });
    await setupWithProviders(env, twoEntries);
    const res = await callApp(env, "/api/providers/reorder", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ from: 0, to: 7 }),
    });
    expect(res.status).toBe(422);
    const body = (await (
      await callApp(env, "/api/providers", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { entries: Array<{ label: string }> };
    expect(body.entries.map((e) => e.label)).toEqual(["g", "t"]);
  });
});

describe("GET /api/status", () => {
  it("is public and carries booleans plus warning copy only", async () => {    const env = makeEnv();
    await setupWithProviders(env, []);
    const body = (await (
      await callApp(env, "/api/status")
    ).json()) as Record<string, unknown>;
    expect(body.degraded).toBe(true);
    expect(body.warning).toMatch(/static fallback/i);
    expect(body.provisioned).toBe(true);
    expect(body.operator_token_set).toBe(true);
    expect(Object.keys(body).sort()).toEqual([
      "build",
      "degraded",
      "operator_token_set",
      "provisioned",
      "warning",
    ]);
  });
});

describe("save-time validation wired into POST /api/setup", () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    kind: "providers",
    providers: [
      {
        kind: "openai-compatible",
        label: "c",
        secret_slot: "GROQ_API_KEY",
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
      await callApp(env, "/api/setup", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as Record<string, unknown>;
    const text = JSON.stringify(saved);
    expect(text).not.toContain('"apiKey"');
    expect(text).toContain("GROQ_API_KEY");
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

describe("secret-slot choke point", () => {
  const env = {
    OPERATOR_TOKEN: "op",
    SERVER_SECRET: "server",
    ENCRYPTION_KEY: "enc",
    CF_OAUTH_CLIENT_SECRET: "cf",
    TURNSTILE_SECRET: "ts",
    GROQ_API_KEY: "provider-key",
  } as never;

  it("never resolves an installation secret through secretValue", () => {
    for (const slot of [
      "OPERATOR_TOKEN",
      "SERVER_SECRET",
      "ENCRYPTION_KEY",
      "CF_OAUTH_CLIENT_SECRET",
      "TURNSTILE_SECRET",
      "SOME_FUTURE_SECRET",
    ]) {
      expect(secretValue(env, slot)).toBeUndefined();
      expect(hasSecretValue(env, slot)).toBe(false);
    }
    expect(secretValue(env, "GROQ_API_KEY")).toBe("provider-key");
  });

  it("422s a providers step that names an installation secret as the slot", async () => {
    const res = await callApp(makeEnv(), "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        kind: "providers",
        providers: [
          {
            kind: "groq",
            label: "exfil",
            secret_slot: "OPERATOR_TOKEN",
            model: "m",
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
  });

  it("422s a providers step with a loopback base URL", async () => {
    const res = await callApp(makeEnv(), "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        kind: "providers",
        providers: [
          {
            kind: "openai-compatible",
            label: "probe",
            secret_slot: "GROQ_API_KEY",
            model: "m",
            base_url: "http://127.0.0.1:8101",
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
  });

  it("drops pre-existing hostile entries on boot", async () => {
    const db = new FakeD1();
    const first = {
      DB: db as never,
      OPERATOR_TOKEN: TOKEN,
      SERVER_SECRET: "server-secret-for-tests",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
    };
    await callApp(first, "/api/status"); // boot the schema
    const stored = {
      phase: "ready",
      providers: [
        { kind: "groq", label: "evil", secret_slot: "OPERATOR_TOKEN", model: "m" },
        {
          kind: "openai-compatible",
          label: "internal",
          secret_slot: "GROQ_API_KEY",
          model: "m",
          base_url: "http://169.254.169.254/v1",
        },
        { kind: "groq", label: "ok", secret_slot: "GROQ_API_KEY", model: "m" },
      ],
      instrument: { title: "t", blurb: "b", consent: "c" },
      installed_at: "2026-01-01T00:00:00Z",
    };
    await db
      .prepare("INSERT INTO setup_state (id, state_json) VALUES (1, ?)")
      .bind(JSON.stringify(stored))
      .run();
    const second = {
      DB: db as never,
      OPERATOR_TOKEN: TOKEN,
      GROQ_API_KEY: "k",
      SERVER_SECRET: "server-secret-for-tests",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
    };
    const chain = (await (
      await callApp(second, "/api/providers", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { degraded: boolean; entries: Array<{ label: string }> };
    expect(chain.degraded).toBe(false);
    expect(chain.entries.map((e) => e.label)).toEqual(["ok"]);
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

describe("public setup view", () => {
  it("redacts provider entries without the operator token", async () => {
    const env = makeEnv({ GROQ_API_KEY: "k" });
    await setupWithProviders(env, [
      { kind: "groq", label: "g", secret_slot: "GROQ_API_KEY", model: "m" },
    ]);
    const anon = (await (
      await callApp(env, "/api/setup")
    ).json()) as Record<string, unknown>;
    expect(anon.providers).toBeUndefined();
    expect(anon.phase).toBe("corpus");

    const authed = (await (
      await callApp(env, "/api/setup", {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as Record<string, unknown>;
    expect(Array.isArray(authed.providers)).toBe(true);
  });
});

describe("provisioning", () => {
  it("fails closed and reports provisioned:false without key material", async () => {
    const env = { DB: new FakeD1() as never, OPERATOR_TOKEN: TOKEN };
    const status = (await (
      await callApp(env, "/api/status")
    ).json()) as Record<string, unknown>;
    expect(status.provisioned).toBe(false);
    expect(status.degraded).toBe(true);
    expect(String(status.warning)).toMatch(/SERVER_SECRET/);

    const sealed = await callApp(env, "/api/intake/challenge");
    expect(sealed.status).toBe(503);
    const body = (await sealed.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_provisioned");
  });
});
