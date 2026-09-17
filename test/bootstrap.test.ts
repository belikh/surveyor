import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";
import {
  bootstrapInstallation,
  masterSlotPresence,
  type BootstrapInput,
} from "../src/lib/bootstrap";

// A1: a fresh deployment boots with no SERVER_SECRET / ENCRYPTION_KEY /
// OPERATOR_TOKEN. The wizard must still be able to complete setup: the
// bootstrap route writes the master slots through a transient Cloudflare
// token, the operator chooses its own operator token, and no generated
// secret value is ever returned.

const input: BootstrapInput = {
  cf_token: "cf-transient-token",
  account_id: "acct-1",
  script_name: "surveyor",
  operator_token: "operator-chosen-token",
};

/** Capture the secret PUTs the bootstrap path makes. */
function captureCfPuts() {
  const puts: Array<{ name: string; text: string }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        name: string;
        text: string;
      };
      puts.push(body);
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { puts, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootstrapInstallation", () => {
  it("writes the missing master slots and reports booleans only", async () => {
    const { puts, fetchImpl } = captureCfPuts();
    const receipt = await bootstrapInstallation({}, input, fetchImpl);
    expect(receipt.slots).toEqual([
      { slot: "SERVER_SECRET", set: true, generated: true, written: true },
      { slot: "ENCRYPTION_KEY", set: true, generated: true, written: true },
      { slot: "OPERATOR_TOKEN", set: true, generated: false, written: true },
    ]);
    const byName = Object.fromEntries(puts.map((p) => [p.name, p.text]));
    // The operator token is exactly the operator's choice, never minted.
    expect(byName.OPERATOR_TOKEN).toBe("operator-chosen-token");
    // The encryption key is 64 hex characters (the vault's expectation).
    expect(byName.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    // The receipt itself carries no value.
    const serialised = JSON.stringify(receipt);
    expect(serialised).not.toContain("operator-chosen-token");
    for (const p of puts) {
      if (p.name !== "OPERATOR_TOKEN") {
        expect(serialised).not.toContain(p.text);
      }
    }
  });

  it("requires an operator-chosen token and refuses to mint one", async () => {
    const { puts, fetchImpl } = captureCfPuts();
    await expect(
      bootstrapInstallation({}, { ...input, operator_token: undefined }, fetchImpl),
    ).rejects.toMatchObject({
      name: "BootstrapError",
      code: "operator_token_required",
    });
    expect(puts).toEqual([]);
  });

  it("fills only missing slots and never rotates a set one", async () => {
    const { puts, fetchImpl } = captureCfPuts();
    const receipt = await bootstrapInstallation(
      { SERVER_SECRET: "already-set", ENCRYPTION_KEY: "e".repeat(64) },
      input,
      fetchImpl,
    );
    expect(puts.map((p) => p.name)).toEqual(["OPERATOR_TOKEN"]);
    expect(receipt.slots).toEqual([
      { slot: "SERVER_SECRET", set: true, generated: false, written: false },
      { slot: "ENCRYPTION_KEY", set: true, generated: false, written: false },
      { slot: "OPERATOR_TOKEN", set: true, generated: false, written: true },
    ]);
  });

  it("refuses once every master slot is set", async () => {
    const { puts, fetchImpl } = captureCfPuts();
    await expect(
      bootstrapInstallation(
        {
          SERVER_SECRET: "s",
          ENCRYPTION_KEY: "e".repeat(64),
          OPERATOR_TOKEN: "t",
        },
        input,
        fetchImpl,
      ),
    ).rejects.toMatchObject({
      name: "BootstrapError",
      code: "already_provisioned",
    });
    expect(puts).toEqual([]);
  });

  it("reports presence by truthiness, never by value", () => {
    expect(masterSlotPresence({})).toEqual({
      SERVER_SECRET: false,
      ENCRYPTION_KEY: false,
      OPERATOR_TOKEN: false,
    });
    expect(
      masterSlotPresence({ SERVER_SECRET: "x", ENCRYPTION_KEY: "y" }),
    ).toEqual({
      SERVER_SECRET: true,
      ENCRYPTION_KEY: true,
      OPERATOR_TOKEN: false,
    });
  });
});

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: new FakeD1() as never,
    ...extra,
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

describe("fresh-install bootstrap route (A1)", () => {
  it("boots the wizard: status is honest and /api/bootstrap installs the slots", async () => {
    const env = makeEnv();
    const status = await callApp(env, "/api/status");
    expect(status.status).toBe(200);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body.provisioned).toBe(false);
    expect(body.operator_token_set).toBe(false);
    expect(String(body.warning)).toMatch(/boot/i);

    // The first-run shell and its status surface are reachable while
    // unprovisioned; the public root is the survey, which needs boot state.
    expect((await callApp(env, "/setup")).status).toBe(200);

    const { puts, fetchImpl } = captureCfPuts();
    vi.stubGlobal("fetch", fetchImpl);
    const res = await callApp(env, "/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as {
      ok: boolean;
      slots: Array<Record<string, unknown>>;
    };
    expect(receipt.ok).toBe(true);
    for (const s of receipt.slots) {
      expect(Object.keys(s).sort()).toEqual([
        "generated",
        "set",
        "slot",
        "written",
      ]);
    }
    expect(JSON.stringify(receipt)).not.toContain("operator-chosen-token");
    expect(puts.map((p) => p.name).sort()).toEqual([
      "ENCRYPTION_KEY",
      "OPERATOR_TOKEN",
      "SERVER_SECRET",
    ]);
  });

  it("422s when no operator token is chosen", async () => {
    const { fetchImpl } = captureCfPuts();
    vi.stubGlobal("fetch", fetchImpl);
    const res = await callApp(makeEnv(), "/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, operator_token: undefined }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "operator_token_required",
    );
  });

  it("409s once provisioned, so re-posting cannot rotate anything", async () => {
    const res = await callApp(
      makeEnv({
        SERVER_SECRET: "s",
        ENCRYPTION_KEY: "e".padEnd(64, "0"),
        OPERATOR_TOKEN: "t",
      }),
      "/api/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "already_provisioned",
    );
  });

  it("reaches a writable wizard after boot, and a provisioned boot needs no bootstrap", async () => {
    // Simulate the isolate that starts after the secret write: same values
    // the bootstrap PUT, now live bindings.
    const { puts, fetchImpl } = captureCfPuts();
    await bootstrapInstallation({}, input, fetchImpl);
    const live = Object.fromEntries(puts.map((p) => [p.name, p.text]));
    const env = makeEnv({
      SERVER_SECRET: live.SERVER_SECRET,
      ENCRYPTION_KEY: live.ENCRYPTION_KEY,
      OPERATOR_TOKEN: live.OPERATOR_TOKEN,
    });

    const status = (await (
      await callApp(env, "/api/status")
    ).json()) as Record<string, unknown>;
    expect(status.provisioned).toBe(true);
    expect(status.operator_token_set).toBe(true);

    const advanced = await callApp(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${live.OPERATOR_TOKEN}`,
      },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    expect(advanced.status).toBe(200);
    expect(((await advanced.json()) as { phase: string }).phase).toBe("corpus");
  });
});
