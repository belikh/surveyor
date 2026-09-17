// D4 — privacy and collection notice generator: notices built from the
// installation's actual data flows, with the automated-decision disclosure,
// exported as append-only versions.

import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

const TOKEN = "op-token";

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    ...extra,
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

const OPERATOR = {
  operator_name: "Example Union",
  operator_contact: "privacy@example-union.org.au",
};

async function configureProvider(
  env: Record<string, unknown>,
  entry: Record<string, unknown> = {
    kind: "groq",
    label: "Groq",
    secret_slot: "GROQ_API_KEY",
    model: "llama-3.3-70b-versatile",
    capabilities: ["chat", "vision"],
  },
) {
  return callApp(env, "/api/setup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ kind: "providers", providers: [entry] }),
  });
}

async function generate(
  env: Record<string, unknown>,
  operator: Record<string, unknown> = OPERATOR,
) {
  const res = await callApp(env, "/api/notices/generate", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(operator),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, never>,
  };
}

async function latest(env: Record<string, unknown>, type: string) {
  const res = await callApp(env, `/api/notices/${type}`, { headers: auth });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, never>,
  };
}

describe("notice generator routes", () => {
  it("401s without the operator token", async () => {
    const res = await callApp(makeEnv(), "/api/notices");
    expect(res.status).toBe(401);
  });

  it("generates notices from the installation's actual data flows", async () => {
    const env = makeEnv({ GROQ_API_KEY: "sk-test" });
    await configureProvider(env);
    const gen = await generate(env);
    expect(gen.status).toBe(201);
    const notices = gen.body.notices as Array<Record<string, unknown>>;
    expect(notices.map((n) => n.type)).toEqual(["privacy", "collection"]);

    const privacy = await latest(env, "privacy");
    expect(privacy.status).toBe(200);
    expect(privacy.body.version).toBe(1);
    const body = privacy.body.body as string;
    expect(body).toContain("# Privacy policy");
    expect(body).toContain(OPERATOR.operator_name);
    expect(body).toContain(OPERATOR.operator_contact);
    // Configured provider is named as a recipient; unconfigured ones are not.
    expect(body).toContain("Groq");
    expect(body).toContain("llama-3.3-70b-versatile");
    expect(body).not.toContain("TokenRouter");
    // Hosting and the no-Australian-jurisdiction fact are disclosed.
    expect(body).toContain("Cloudflare");
    expect(body).toContain("outside Australia");
    // The flow snapshot records the same fact.
    const flows = privacy.body.data_flows as Record<string, never>;
    expect(
      (flows.providers as Array<Record<string, unknown>>).map((p) => p.label),
    ).toEqual(["Groq"]);
  });

  it("lists a provider with no key as not a recipient", async () => {
    const env = makeEnv();
    await configureProvider(env);
    await generate(env);
    const body = (await latest(env, "privacy")).body.body as string;
    expect(body).not.toContain("Groq");
    expect(body).toContain("No model provider key is configured");
  });

  it("names the keyless tier and the human check only when present", async () => {
    const plain = makeEnv();
    await generate(plain);
    expect((await latest(plain, "privacy")).body.body as string).not.toContain(
      "Workers AI",
    );

    const extra = makeEnv({ AI: {}, TURNSTILE_SECRET: "turnstile-secret" });
    await generate(extra);
    const body = (await latest(extra, "privacy")).body.body as string;
    expect(body).toContain("Workers AI");
    expect(body).toContain("Turnstile");
  });

  it("includes the automated-decision disclosure in both notices", async () => {
    const env = makeEnv();
    await generate(env);
    for (const type of ["privacy", "collection"]) {
      const body = (await latest(env, type)).body.body as string;
      expect(body, type).toContain("## Automated decisions");
      expect(body, type).toContain("manual approval is the default");
      expect(body, type).toContain("Privacy Principle 1.7");
    }
  });

  it("lists versions and exports a chosen version as markdown", async () => {
    const env = makeEnv();
    await generate(env);
    const versions = (await (
      await callApp(env, "/api/notices/privacy/versions", { headers: auth })
    ).json()) as { versions: Array<{ version: number }> };
    expect(versions.versions.map((v) => v.version)).toEqual([1]);

    const res = await callApp(env, "/api/notices/privacy/versions/1/export", {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("privacy");
    expect(await res.text()).toContain(OPERATOR.operator_name);
  });

  it("versions up when the data flows change, keeping old versions", async () => {
    const env = makeEnv({ GROQ_API_KEY: "sk-test" });
    await generate(env);
    const v1 = (await latest(env, "privacy")).body;
    expect(v1.body as string).not.toContain("Groq");

    await configureProvider(env);
    await generate(env);
    const v2 = (await latest(env, "privacy")).body;
    expect(v2.version).toBe(2);
    expect(v2.body as string).toContain("Groq");

    const versions = (await (
      await callApp(env, "/api/notices", { headers: auth })
    ).json()) as {
      versions: Array<{ type: string; version: number }>;
    };
    expect(versions.versions.map((v) => `${v.type}:${v.version}`)).toEqual([
      "collection:1",
      "collection:2",
      "privacy:1",
      "privacy:2",
    ]);

    // v1 stays exportable and unchanged: versioning is append-only.
    const old = await callApp(env, "/api/notices/privacy/versions/1/export", {
      headers: auth,
    });
    expect(await old.text()).not.toContain("Groq");
  });

  it("404s unknown types and versions, 422s missing operator identity", async () => {
    const env = makeEnv();
    expect((await latest(env, "nonsense")).status).toBe(404);
    await generate(env);
    const missing = await callApp(
      env,
      "/api/notices/privacy/versions/9/export",
      { headers: auth },
    );
    expect(missing.status).toBe(404);
    const bad = await generate(env, { operator_name: "No Contact" });
    expect(bad.status).toBe(422);
  });
});
