import { describe, it, expect } from "vitest";
import {
  resolveChain,
  reorderProviders,
  validateCustomProvider,
  type ChainResolution,
} from "../src/lib/registry";
import { recordTurn, listTelemetry } from "../src/lib/telemetry";
import type { ProviderEntry, SetupState } from "../src/lib/setup";
import { FakeD1 } from "./helpers/d1";

function entry(over: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    kind: "openai-compatible",
    label: "test",
    secret_slot: "GROQ_API_KEY",
    model: "test-model",
    base_url: "https://llm.example/v1",
    ...over,
  };
}

function stateWith(providers: ProviderEntry[]): SetupState {
  return {
    phase: "ready",
    providers,
    instrument: { title: "T", blurb: "B", consent: "C" },
    installed_at: "2026-09-16T00:00:00Z",
  };
}

describe("resolveChain", () => {
  it("honours operator order and skips entries with missing secrets", () => {
    const a = entry({ label: "a", secret_slot: "GROQ_API_KEY" });
    const b = entry({ label: "b", secret_slot: "TOKENROUTER_API_KEY" });
    const r: ChainResolution = resolveChain(
      stateWith([a, b]),
      (slot) => slot === "TOKENROUTER_API_KEY",
    );
    expect(r.entries.map((e) => e.label)).toEqual(["b"]);
    expect(r.degraded).toBe(false);
    expect(r.warning).toBeNull();
  });

  it("degrades with a dashboard warning when nothing is usable", () => {
    const r = resolveChain(stateWith([entry()]), () => false);
    expect(r.entries).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.warning).toMatch(/static fallback/i);
  });

  it("treats groq/tokenrouter kinds the same as customs for availability", () => {
    const g = entry({ kind: "groq", label: "g", secret_slot: "GROQ_API_KEY" });
    const t = entry({ kind: "tokenrouter", label: "t", secret_slot: "TOKENROUTER_API_KEY" });
    const r = resolveChain(stateWith([g, t]), () => true);
    expect(r.entries.map((e) => e.label)).toEqual(["g", "t"]);
  });
});

describe("reorderProviders", () => {
  it("moves an entry and rejects out-of-range indices", () => {
    const ps = [entry({ label: "a" }), entry({ label: "b" })];
    expect(reorderProviders(ps, 0, 1).map((e) => e.label)).toEqual([
      "b",
      "a",
    ]);
    expect(() => reorderProviders(ps, 0, 5)).toThrow(/range/);
    expect(() => reorderProviders(ps, -1, 0)).toThrow(/range/);
  });
});

describe("validateCustomProvider", () => {
  const okFetch = async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200 });

  it("passes on a 200 test call", async () => {
    const r = await validateCustomProvider(
      { label: "c", baseUrl: "https://llm.example/v1", model: "m", apiKey: "k" },
      okFetch as typeof fetch,
    );
    expect(r).toEqual({ ok: true });
  });

  it("fails loud on 401, naming the provider and status", async () => {
    const r = await validateCustomProvider(
      { label: "c", baseUrl: "https://llm.example/v1", model: "m", apiKey: "bad" },
      (async () => new Response("nope", { status: 401 })) as typeof fetch,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/c/);
      expect(r.error).toMatch(/401/);
    }
  });

  it("fails loud on network failure without leaking the key", async () => {
    const boom = async () => {
      throw new Error("socket hung up");
    };
    const r = await validateCustomProvider(
      {
        label: "c",
        baseUrl: "https://llm.example/v1",
        model: "m",
        apiKey: "sk-supersecret",
      },
      boom as typeof fetch,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/socket hung up/);
      expect(r.error).not.toContain("sk-supersecret");
    }
  });

  it("rejects a non-URL base up front", async () => {
    const r = await validateCustomProvider(
      { label: "c", baseUrl: "not-a-url", model: "m", apiKey: "k" },
      okFetch as typeof fetch,
    );
    expect(r.ok).toBe(false);
  });

  it("refuses to follow redirects to the destination", async () => {
    let sawRedirect: string | undefined;
    const redirecting = (async (_url: string, init?: RequestInit) => {
      sawRedirect = init?.redirect as string | undefined;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:8788/api/setup" },
      });
    }) as typeof fetch;
    const r = await validateCustomProvider(
      { label: "c", baseUrl: "https://llm.example/v1", model: "m", apiKey: "k" },
      redirecting,
    );
    expect(r.ok).toBe(false);
    expect(sawRedirect).toBe("manual");
  });
});

describe("telemetry", () => {
  it("records turns and lists newest-first with a limit", async () => {
    const db = new FakeD1() as never;
    // Boot the telemetry table the same way state.ts does.
    const { boot } = await import("../src/state");
    await boot({
      DB: db,
      OPERATOR_TOKEN: "",
      SERVER_SECRET: "server-secret-for-tests",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
    } as never);
    await recordTurn(db, { tier: "groq", toolCalls: 3, label: "round-1" });
    await recordTurn(db, { tier: "static", toolCalls: 0, label: "round-2" });
    const rows = await listTelemetry(db, 10);
    expect(rows.map((r) => r.tier)).toEqual(["static", "groq"]);
    expect(rows[1]).toMatchObject({ toolCalls: 3, label: "round-1" });
    const one = await listTelemetry(db, 1);
    expect(one).toHaveLength(1);
  });
});
