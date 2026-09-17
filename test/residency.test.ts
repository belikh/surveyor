// D6 (#49) — residency and data-flow receipts: the map is derived from the
// installation's actual configured services and providers, names each
// recipient with the regions it may process in, and makes no residency claim
// the platform cannot keep.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import { unwrap } from "../src/lib/evidence";
import {
  collectDataFlowMap,
  renderDataFlowReceipt,
} from "../src/lib/residency";
import type { ProviderEntry, SetupState } from "../src/lib/setup";

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: TOKEN,
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    ...extra,
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

function setupWith(providers: ProviderEntry[]): SetupState {
  return {
    phase: "ready",
    providers,
    instrument: { title: "Example investigation", blurb: "B", consent: "C" },
    installed_at: "2026-09-17T00:00:00.000Z",
  };
}

const GROQ: ProviderEntry = {
  kind: "groq",
  label: "Groq",
  secret_slot: "GROQ_API_KEY",
  model: "llama-3.3-70b-versatile",
  capabilities: ["chat", "vision"],
};

const PARALLEL: ProviderEntry = {
  kind: "parallel",
  label: "Parallel",
  secret_slot: "PARALLEL_API_KEY",
  model: "search",
  capabilities: ["search"],
};

/** The provider test call and the Cloudflare secret API (key entry route). */
function stubCloudflare() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (u.includes("/workers/scripts/") && u.includes("/secrets")) {
      void init;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });
}

function keyEntryBody() {
  return JSON.stringify({
    cf_token: "cf-secret-token",
    account_id: "acct-123",
    script_name: "surveyor",
    kind: "groq",
    label: "Groq",
    model: "llama-3.3-70b-versatile",
    secret_slot: "GROQ_API_KEY",
    api_key: "sk-live-secret-xyz",
    capabilities: ["chat"],
  });
}

const CF_CREDS = JSON.stringify({
  cf_token: "cf-secret-token",
  account_id: "acct-123",
  script_name: "surveyor",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("data-flow map (D6, #49)", () => {
  it("names Cloudflare with the services actually configured and honest regions", () => {
    const map = collectDataFlowMap({
      setup: setupWith([]),
      hasSecret: () => false,
      workersAi: true,
      turnstile: true,
    });
    const cf = map.recipients[0];
    expect(cf.name).toBe("Cloudflare");
    expect(cf.services).toEqual([
      "Workers",
      "D1",
      "R2",
      "Queues",
      "Workflows",
      "Workers AI",
      "Turnstile",
    ]);
    expect(cf.regions).toMatch(/no Australian/i);
    expect(cf.regions).toMatch(/outside Australia/);
    expect(cf.region_source).toBe("platform");
    expect(cf.may_process_offshore).toBe(true);

    // A keyless installation without the human check does not name tiers it
    // does not use.
    const plain = collectDataFlowMap({
      setup: setupWith([]),
      hasSecret: () => false,
      workersAi: false,
      turnstile: false,
    });
    expect(plain.recipients[0].services).not.toContain("Workers AI");
    expect(plain.recipients[0].services).not.toContain("Turnstile");

    // The boundaries state the platform facts and the anonymity posture.
    const boundaries = map.boundaries.join(" ");
    expect(boundaries).toContain("outside Australia");
    expect(boundaries).toMatch(/no jurisdiction restriction is configured/);
    expect(boundaries).toMatch(/no Tor/);
  });

  it("names each configured and keyed provider with a region statement", () => {
    const map = collectDataFlowMap({
      setup: setupWith([GROQ, PARALLEL]),
      hasSecret: (slot) => slot === "PARALLEL_API_KEY",
      workersAi: false,
      turnstile: false,
    });
    expect(map.recipients.map((r) => r.name)).toEqual(["Cloudflare", "Parallel"]);
    const parallel = map.recipients[1];
    expect(parallel.regions).toContain("United States");
    expect(parallel.regions).toMatch(/EU residency/);
    expect(parallel.region_source).toBe("provider-review");
    expect(parallel.may_process_offshore).toBe(true);
    expect(parallel.services.join(" ")).toContain("search");
  });

  it("says a provider's region is not recorded rather than inventing one", () => {
    const map = collectDataFlowMap({
      setup: setupWith([GROQ]),
      hasSecret: (slot) => slot === "GROQ_API_KEY",
      workersAi: false,
      turnstile: false,
    });
    const groq = map.recipients.find((r) => r.name === "Groq")!;
    expect(groq.regions).toMatch(/not recorded/i);
    expect(groq.regions).toMatch(/outside Australia/);
    expect(groq.region_source).toBe("not-recorded");
  });

  it("updates as providers change", () => {
    const withGroq = collectDataFlowMap({
      setup: setupWith([GROQ]),
      hasSecret: () => true,
      workersAi: false,
      turnstile: false,
    });
    const without = collectDataFlowMap({
      setup: setupWith([]),
      hasSecret: () => true,
      workersAi: false,
      turnstile: false,
    });
    expect(withGroq.recipients.map((r) => r.name)).toEqual(["Cloudflare", "Groq"]);
    expect(without.recipients.map((r) => r.name)).toEqual(["Cloudflare"]);
  });

  it("renders a receipt naming recipients, regions and the boundaries", () => {
    const map = collectDataFlowMap({
      setup: setupWith([GROQ]),
      hasSecret: (slot) => slot === "GROQ_API_KEY",
      workersAi: true,
      turnstile: false,
    });
    const md = renderDataFlowReceipt(map);
    expect(md).toContain("# Data-flow and residency receipt");
    expect(md).toContain("## Recipients");
    expect(md).toContain("Cloudflare");
    expect(md).toContain("Groq");
    expect(md).toContain("Workers AI");
    expect(md).toContain("## What is stored where");
    expect(md).toContain("## Boundaries");
    expect(md).toContain("outside Australia");
    expect(md).not.toMatch(/stays? in Australia/i);
  });
});

describe("residency routes (D6, #49)", () => {
  it("401s without the operator token", async () => {
    const env = makeEnv();
    for (const [path, method] of [
      ["/api/residency", "GET"],
      ["/api/residency/receipts", "POST"],
      ["/api/residency/receipts", "GET"],
    ] as const) {
      const res = await callApp(env, path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("serves the live map and follows provider configuration changes", async () => {
    stubCloudflare();
    const env = makeEnv({ GROQ_API_KEY: "sk-test" });
    const before = (await (
      await callApp(env, "/api/residency", { headers: auth })
    ).json()) as { recipients: Array<{ name: string }> };
    expect(before.recipients.map((r) => r.name)).toEqual(["Cloudflare"]);

    const added = await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: keyEntryBody(),
    });
    expect(added.status).toBe(200);
    const withProvider = (await (
      await callApp(env, "/api/residency", { headers: auth })
    ).json()) as { recipients: Array<{ name: string; regions: string }> };
    expect(withProvider.recipients.map((r) => r.name)).toEqual([
      "Cloudflare",
      "Groq",
    ]);
    expect(withProvider.recipients[1].regions).toMatch(/not recorded/i);

    const removed = await callApp(env, "/api/providers/key/GROQ_API_KEY", {
      method: "DELETE",
      headers: auth,
      body: CF_CREDS,
    });
    expect(removed.status).toBe(200);
    const after = (await (
      await callApp(env, "/api/residency", { headers: auth })
    ).json()) as { recipients: Array<{ name: string }> };
    expect(after.recipients.map((r) => r.name)).toEqual(["Cloudflare"]);
  });

  it("records, lists and exports append-only receipts", async () => {
    const env = makeEnv();
    const first = await callApp(env, "/api/residency/receipts", {
      method: "POST",
      headers: auth,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      receipt: { id: string; created_at: string; map: { recipients: unknown[] } };
    };
    expect(firstBody.receipt.id).toBeTruthy();
    expect(firstBody.receipt.map.recipients).toHaveLength(1);

    const second = await callApp(env, "/api/residency/receipts", {
      method: "POST",
      headers: auth,
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { receipt: { id: string } };
    expect(secondBody.receipt.id).not.toBe(firstBody.receipt.id);

    const list = (await (
      await callApp(env, "/api/residency/receipts", { headers: auth })
    ).json()) as { receipts: Array<{ id: string; created_at: string }> };
    expect(list.receipts.map((r) => r.id)).toEqual([
      firstBody.receipt.id,
      secondBody.receipt.id,
    ]);

    const exportRes = await callApp(
      env,
      `/api/residency/receipts/${firstBody.receipt.id}/export`,
      { headers: auth },
    );
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toContain("text/markdown");
    const md = await exportRes.text();
    expect(md).toContain("Cloudflare");
    expect(md).toContain("outside Australia");

    const missing = await callApp(env, "/api/residency/receipts/nope/export", {
      headers: auth,
    });
    expect(missing.status).toBe(404);
  });

  it("records a data-flow receipt with the provisioning receipt", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.endsWith("/d1/database")) {
        return new Response(
          JSON.stringify({ success: true, result: { uuid: "d1-1" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.endsWith("/secrets")) {
        return new Response(
          JSON.stringify({ success: true, result: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ success: true, result: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const env = makeEnv();
    const res = await callApp(env, "/api/provision", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        cf_token: "cf-transient-token",
        account_id: "acct-1",
        script_name: "surveyor",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data_flow: { id: string; map: { recipients: Array<{ name: string }> } };
    };
    expect(body.ok).toBe(true);
    expect(body.data_flow.map.recipients[0].name).toBe("Cloudflare");

    const rows = unwrap(
      await (env.DB as FakeD1)
        .prepare("SELECT id, map_json FROM data_flow_receipts")
        .bind()
        .all<{ id: string; map_json: string }>(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(body.data_flow.id);
    expect(rows[0].map_json).toContain("Cloudflare");
  });
});

describe("residency documentation (D6, #49)", () => {
  const root = join(__dirname, "..");
  const read = (name: string) => readFileSync(join(root, name), "utf8");

  it("states the cross-border posture plainly in the operator documents", () => {
    for (const name of ["README.md", "RUNBOOK.md"]) {
      const text = read(name);
      expect(text, name).toMatch(/outside\s+Australia/);
      expect(text, name).toMatch(/no\s+Australian/i);
      expect(text, name).not.toMatch(/stays? in Australia/i);
    }
    expect(read("RUNBOOK.md")).toContain("/api/residency");
    expect(read("RUNBOOK.md")).toContain("## Errata");
  });

  it("keeps the unverifiable residency phrases out of the shipped text", () => {
    const forbidden = [
      /data (?:is )?(?:stored|hosted) in australia/i,
      /australian data residency (?:is )?(?:available|supported)/i,
      /guarantees? australian (?:storage|residency)/i,
    ];
    for (const name of ["README.md", "RUNBOOK.md"]) {
      const text = read(name);
      for (const pattern of forbidden) {
        expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
