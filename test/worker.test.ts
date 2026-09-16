import { describe, it, expect } from "vitest";
import app from "../src/index";
import { FakeD1 } from "./helpers/d1";

function makeEnv(operatorToken = "") {
  return { DB: new FakeD1() as never, OPERATOR_TOKEN: operatorToken };
}

async function fetch_(
  env: ReturnType<typeof makeEnv>,
  path: string,
  init?: RequestInit,
) {
  return app.fetch(new Request(`https://surveyor.example${path}`, init), env);
}

describe("operator auth (disabled-until-set)", () => {
  it("404s every setup write while the token is unset", async () => {
    const env = makeEnv();
    const res = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("401s setup writes with a wrong token, accepts the right one", async () => {
    const env = makeEnv("correct-horse-battery");
    const bad = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    expect(bad.status).toBe(401);
    const good = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer correct-horse-battery",
      },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    expect((await good.json() as Record<string, unknown>).phase).toBe("corpus");
  });

  it("rejects invalid step payloads with 422, never 500", async () => {
    const env = makeEnv("tok");
    const res = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok",
      },
      body: JSON.stringify({ kind: "nonsense" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("surveyor worker", () => {
  it("serves the wizard shell with FR-13-style security headers", async () => {
    const res = await fetch_(makeEnv(), "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toContain("Surveyor");
  });

  it("serves wizard.js as javascript with no-store", async () => {
    const res = await fetch_(makeEnv(), "/wizard.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("GET /api/setup returns fresh welcome state", async () => {
    const res = await fetch_(makeEnv(), "/api/setup");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.phase).toBe("welcome");
  });

  it("walks providers → instrument to ready via POST /api/setup", async () => {
    const env = makeEnv("tok");
    await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    }).then((r) => r.json());
    const res = await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({
        kind: "instrument",
        title: "T",
        blurb: "B",
        consent: "C",
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.phase).toBe("ready");
    expect((body.instrument as Record<string, string>).title).toBe("T");
  });

  it("teardown before ready is 409 setup_incomplete", async () => {
    const res = await fetch_(makeEnv("tok"), "/api/teardown", { method: "POST", headers: { authorization: "Bearer tok" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "setup_incomplete" });
  });

  it("teardown after ready returns honest receipts", async () => {
    const env = makeEnv("tok");
    await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({ kind: "providers", providers: [] }),
    });
    await fetch_(env, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({
        kind: "instrument",
        title: "T",
        blurb: "B",
        consent: "C",
      }),
    });
    const res = await fetch_(env, "/api/teardown", { method: "POST", headers: { authorization: "Bearer tok" } });
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.wiped as Record<string, string>).local_setup_state).toBe("reset-to-fresh");
    // No provision receipt in this env: teardown reports that honestly.
    expect((body.not_wiped as string[]).join(" ")).toContain("no provision receipt");
    // State reset to welcome: a subsequent setup read shows fresh state.
    const after = (await fetch_(env, "/api/setup").then((r) => r.json())) as Record<string, unknown>;
    expect(after.phase).toBe("welcome");
  });
});
