import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

const creds = {
  cf_token: "cf-transient-token",
  account_id: "acct-1",
  script_name: "surveyor",
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

function json(result: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One stub for every Cloudflare endpoint the provisioner/teardown touch.
 *  `existingSecrets` names the slots the Worker secret store already holds;
 *  `puts` records every secret the stub was asked to write. */
function stubCloudflare(
  overrides: Partial<Record<string, () => Response>> = {},
  existingSecrets: string[] = [],
) {
  const puts: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = String(url);
    const m = (init?.method ?? "GET").toUpperCase();
    const key = `${m} ${u.replace(/https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct-1/, "").split("?")[0]}`;
    for (const [pattern, make] of Object.entries(overrides)) {
      if (key.includes(pattern)) return make!();
    }
    if (m === "POST" && u.endsWith("/d1/database")) return json({ uuid: "d1-1" });
    if (m === "POST" && u.endsWith("/r2/buckets")) return json({});
    if (m === "POST" && u.endsWith("/queues")) return json({ queue_id: "q-1" });
    if (m === "PUT" && u.endsWith("/secrets")) {
      const body = JSON.parse(String(init.body)) as { name: string };
      puts.push(body.name);
    }
    if (m === "GET" && u.endsWith("/secrets")) {
      return json(existingSecrets.map((name) => ({ name })));
    }
    if (m === "GET" && u.includes("/objects")) return json([]);
    return json({});
  });
  return { puts };
}

async function provision(env: Record<string, unknown>) {
  return callApp(env, "/api/provision", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(creds),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime provision (R3)", () => {
  it("provisions the stack and persists a receipt", async () => {
    const { puts } = stubCloudflare();
    const env = makeEnv();
    const res = await provision(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      receipt: { d1: { id: string }; r2: { id: string }; queue: { id: string }; secrets: Array<Record<string, unknown>> };
    };
    expect(body.ok).toBe(true);
    expect(body.receipt.d1.id).toBe("d1-1");
    expect(body.receipt.r2.id).toBe("surveyor-corpus");
    expect(body.receipt.queue.id).toBe("q-1");
    // Only minted slots are written; operator-supplied slots are
    // presence-checked, so the operator token is never overwritten.
    expect(puts.sort()).toEqual(["ENCRYPTION_KEY", "SERVER_SECRET"]);

    const row = (await (env.DB as FakeD1)
      .prepare("SELECT receipt_json FROM provision WHERE id = 1")
      .first()) as { receipt_json: string };
    expect(row.receipt_json).toContain("d1-1");
    // Receipt entries carry slots and booleans, never values.
    for (const s of body.receipt.secrets) {
      expect(Object.keys(s).sort()).toEqual([
        "generated",
        "set",
        "slot",
        "written",
      ]);
    }
  });

  it("re-provisions without rotating existing keys or the operator token (A2)", async () => {
    // The installation is already booted: every slot the plan names is
    // present in the secret store.
    const existing = [
      "SERVER_SECRET",
      "ENCRYPTION_KEY",
      "OPERATOR_TOKEN",
      "GROQ_API_KEY",
      "TOKENROUTER_API_KEY",
      "TURNSTILE_SECRET",
    ];
    const { puts } = stubCloudflare({}, existing);
    const env = makeEnv();
    const res = await provision(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      receipt: { secrets: Array<Record<string, unknown>> };
    };
    expect(body.ok).toBe(true);
    // Nothing was written: no key rotated, no slot touched.
    expect(puts).toEqual([]);
    expect(body.receipt.secrets).toEqual([
      { slot: "SERVER_SECRET", set: true, generated: false, written: false },
      { slot: "ENCRYPTION_KEY", set: true, generated: false, written: false },
      { slot: "OPERATOR_TOKEN", set: true, generated: false, written: false },
      { slot: "GROQ_API_KEY", set: true, generated: false, written: false },
      { slot: "TOKENROUTER_API_KEY", set: true, generated: false, written: false },
      { slot: "TURNSTILE_SECRET", set: true, generated: false, written: false },
    ]);
    // Access survives: the operator token still gates the write surface.
    const setup = await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    expect(setup.status).toBe(200);
  });

  it("fails loud with the failing step, persisting nothing", async () => {
    stubCloudflare({
      "POST /d1/database": () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ message: "quota" }] }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    const env = makeEnv();
    const res = await provision(env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("provision_failed");
    expect(body.step).toBe("createD1");
    const row = await (env.DB as FakeD1)
      .prepare("SELECT receipt_json FROM provision WHERE id = 1")
      .first();
    expect(row ?? null).toBeNull();
  });

  it("requires the operator token", async () => {
    const env = makeEnv();
    const res = await callApp(env, "/api/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(creds),
    });
    expect(res.status).toBe(401);
  });
});

describe("runtime teardown (R3)", () => {
  async function readyEnv() {
    stubCloudflare();
    const env = makeEnv();
    await provision(env);
    // Advance setup to ready so teardown is permitted.
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "instrument", title: "T", blurb: "B", consent: "C" }),
    });
    return env;
  }

  it("uses the receipt to delete the stack and reports honestly", async () => {
    const env = await readyEnv();
    const res = await callApp(env, "/api/teardown", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(creds),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wiped: Record<string, string>;
      not_wiped: string[];
    };
    expect(body.wiped.d1).toBe("deleted");
    expect(body.wiped.r2).toBe("deleted");
    expect(body.wiped.queue).toBe("deleted");
    expect(body.wiped.worker).toBe("deleted");
    expect(body.not_wiped.join(" ")).toMatch(/logs-and-analytics/);
    // Local state reset too.
    const state = (await (await callApp(env, "/api/setup")).json()) as {
      phase: string;
    };
    expect(state.phase).toBe("welcome");
  });

  it("converges on already-deleted resources", async () => {
    const env = await readyEnv();
    stubCloudflare({
      "DELETE /d1/database/d1-1": () => json({}, 404),
      "DELETE /r2/buckets/surveyor-corpus": () => json({}, 404),
    });
    const res = await callApp(env, "/api/teardown", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(creds),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wiped: Record<string, string> };
    expect(body.wiped.d1).toBe("already-gone");
    expect(body.wiped.r2).toBe("already-gone");
  });

  it("400s if a receipt exists but no Cloudflare credentials are given", async () => {
    const env = await readyEnv();
    const res = await callApp(env, "/api/teardown", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("falls back to local reset when no receipt exists", async () => {
    const env = makeEnv();
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    await callApp(env, "/api/setup", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "instrument", title: "T", blurb: "B", consent: "C" }),
    });
    vi.stubGlobal("fetch", async () => json({}));
    const res = await callApp(env, "/api/teardown", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { not_wiped: string[] };
    expect(body.not_wiped.join(" ")).toMatch(/no provision receipt/);
  });
});
