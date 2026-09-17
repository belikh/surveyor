import { describe, it, expect, vi, afterEach } from "vitest";
import app from "../src/index";
import {
  buildSearchClient,
  probeSearchKey,
  SEARCH_BASE_URLS,
  SearchUnavailableError,
  type SearchEntry,
} from "../src/lib/search";
import { liveSearchClient } from "../src/lib/providers";
import { isAllowedProviderBaseUrl } from "../src/lib/net";
import { FakeD1 } from "./helpers/d1";

// B6: Tavily and Parallel are first-class BYOK search/extract providers
// behind the capability-tagged registry. Their output is a pointer — a URL
// plus a fragment — never evidence. The chain follows the operator's order
// and falls through cleanly, and a keyless installation resolves to no
// search client at all so the engine keeps its deterministic floor.

const TOKEN = "op-token";
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

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
  const res = await callApp(env, "/api/setup", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ kind: "providers", providers }),
  });
  expect(res.status).toBe(200);
}

const SECRETS: Record<string, string> = {
  TAVILY_API_KEY: "tvly-test-key",
  PARALLEL_API_KEY: "parallel-test-key",
};
const read = (slot: string) => SECRETS[slot];

const TAVILY: SearchEntry = {
  kind: "tavily",
  label: "tv",
  secret_slot: "TAVILY_API_KEY",
  model: "search",
  capabilities: ["search"],
};
const PARALLEL: SearchEntry = {
  kind: "parallel",
  label: "pl",
  secret_slot: "PARALLEL_API_KEY",
  model: "search",
  capabilities: ["search"],
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string | undefined;
}

/** Stub the outbound provider calls and capture exactly what was sent. */
function stubProviders(
  handler: (seen: Seen, call: number) => Response | Promise<Response>,
) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v;
      }
      const entry: Seen = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        redirect: init?.redirect,
      };
      seen.push(entry);
      return handler(entry, seen.length);
    },
  );
  return seen;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TAVILY_HIT = {
  results: [
    {
      title: "Council minutes",
      url: "https://news.example/a",
      content: "Rosters are posted late",
      published_date: "2026-01-02",
    },
  ],
};

const PARALLEL_HIT = {
  search_id: "s1",
  results: [
    {
      url: "https://news.example/b",
      title: "Gazette",
      excerpts: ["the roster was posted", "late on Tuesday"],
      publish_date: "2026-02-03",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tavily and Parallel adapters", () => {
  it("runs a Tavily search over the worker fetch with the bearer key", async () => {
    const seen = stubProviders(() => json(TAVILY_HIT));
    const client = buildSearchClient([TAVILY], read);
    const pointers = await client.search("roster");

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.tavily.com/search");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.authorization).toBe("Bearer tvly-test-key");
    expect(seen[0].redirect).toBe("manual");
    expect(seen[0].body).toMatchObject({ query: "roster" });
    expect(pointers).toEqual([
      {
        url: "https://news.example/a",
        title: "Council minutes",
        snippet: "Rosters are posted late",
        published: "2026-01-02",
      },
    ]);
  });

  it("runs a Parallel search with the x-api-key header, not bearer", async () => {
    const seen = stubProviders(() => json(PARALLEL_HIT));
    const client = buildSearchClient([PARALLEL], read);
    const pointers = await client.search("roster");

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.parallel.ai/v1/search");
    expect(seen[0].headers["x-api-key"]).toBe("parallel-test-key");
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].body).toMatchObject({ search_queries: ["roster"] });
    expect(pointers).toEqual([
      {
        url: "https://news.example/b",
        title: "Gazette",
        snippet: "the roster was posted late on Tuesday",
        published: "2026-02-03",
      },
    ]);
  });

  it("keeps provider base URLs inside the worker destination policy", () => {
    for (const base of Object.values(SEARCH_BASE_URLS)) {
      expect(isAllowedProviderBaseUrl(base)).toBe(true);
    }
  });
});

describe("search provider chain", () => {
  it("prefers the operator's first provider and does not call the second", async () => {
    const seen = stubProviders(() => json(TAVILY_HIT));
    const client = buildSearchClient([TAVILY, PARALLEL], read);
    expect(client.tier).toBe("tv+pl");
    const pointers = await client.search("roster");
    expect(pointers[0].url).toBe("https://news.example/a");
    expect(seen.every((s) => s.url.startsWith("https://api.tavily.com"))).toBe(
      true,
    );
  });

  it("falls through a 5xx to the next provider", async () => {
    const seen = stubProviders((_s, call) =>
      call === 1 ? json({ detail: "boom" }, 503) : json(PARALLEL_HIT),
    );
    const client = buildSearchClient([TAVILY, PARALLEL], read);
    const pointers = await client.search("roster");
    expect(seen).toHaveLength(2);
    expect(pointers[0].url).toBe("https://news.example/b");
  });

  it("falls through a transport error to the next provider", async () => {
    const seen = stubProviders((_s, call) => {
      if (call === 1) throw new TypeError("network down");
      return json(PARALLEL_HIT);
    });
    const client = buildSearchClient([TAVILY, PARALLEL], read);
    const pointers = await client.search("roster");
    expect(seen).toHaveLength(2);
    expect(pointers).toHaveLength(1);
  });

  it("falls through a 4xx to the next provider", async () => {
    const seen = stubProviders((_s, call) =>
      call === 1 ? json({ detail: "bad key" }, 401) : json(PARALLEL_HIT),
    );
    const client = buildSearchClient([TAVILY, PARALLEL], read);
    const pointers = await client.search("roster");
    expect(seen).toHaveLength(2);
    expect(pointers[0].url).toBe("https://news.example/b");
  });

  it("skips a provider whose secret is absent without calling it", async () => {
    const seen = stubProviders(() => json(PARALLEL_HIT));
    const client = buildSearchClient([TAVILY, PARALLEL], (slot) =>
      slot === "PARALLEL_API_KEY" ? "parallel-test-key" : undefined,
    );
    await client.search("roster");
    expect(seen).toHaveLength(1);
    expect(seen[0].url.startsWith("https://api.parallel.ai")).toBe(true);
  });

  it("reports the chain unavailable when every provider fails", async () => {
    stubProviders(() => json({ detail: "down" }, 502));
    const client = buildSearchClient([TAVILY, PARALLEL], read);
    await expect(client.search("roster")).rejects.toBeInstanceOf(
      SearchUnavailableError,
    );
  });

  it("treats an empty result set as a valid answer, not a failure", async () => {
    const seen = stubProviders(() => json({ results: [] }));
    const client = buildSearchClient([TAVILY, PARALLEL], read);
    expect(await client.search("roster")).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});

describe("extraction leads", () => {
  it("extracts through Tavily and returns a lead, not evidence", async () => {
    const seen = stubProviders(() =>
      json({
        results: [{ url: "https://page.example/a", raw_content: "Page text" }],
        failed_results: [],
      }),
    );
    const client = buildSearchClient([TAVILY], read);
    const lead = await client.extract("https://page.example/a");
    expect(seen[0].url).toBe("https://api.tavily.com/extract");
    expect(seen[0].body).toMatchObject({ urls: ["https://page.example/a"] });
    expect(lead).toEqual({
      url: "https://page.example/a",
      title: "",
      text: "Page text",
    });
  });

  it("extracts through Parallel when the first provider has no content", async () => {
    const seen = stubProviders((s) =>
      s.url.startsWith("https://api.tavily.com")
        ? json({ results: [], failed_results: [{ url: "x", error: "no" }] })
        : json({
            results: [
              {
                url: "https://page.example/a",
                title: "Page",
                excerpts: ["short"],
                full_content: "Full page text",
              },
            ],
            errors: [],
          }),
    );
    const client = buildSearchClient([TAVILY, PARALLEL], read);
    const lead = await client.extract("https://page.example/a");
    expect(seen).toHaveLength(2);
    expect(lead?.text).toBe("Full page text");
  });

  it("returns null when no provider can extract the URL", async () => {
    stubProviders(() => json({ results: [], errors: [] }));
    const client = buildSearchClient([TAVILY, PARALLEL], read);
    expect(await client.extract("https://page.example/a")).toBeNull();
  });
});

describe("per-installation resolution", () => {
  it("returns no search client at all when keyless, keeping the floor", async () => {
    const env = makeEnv();
    await setupWithProviders(env, [TAVILY]);
    expect(
      await liveSearchClient(env.DB as never, env as never),
    ).toBeNull();
  });

  it("resolves the chain from this installation's own state and order", async () => {
    const env = makeEnv({
      TAVILY_API_KEY: "tvly-test-key",
      PARALLEL_API_KEY: "parallel-test-key",
    });
    await setupWithProviders(env, [PARALLEL, TAVILY]);
    const seen = stubProviders(() => json(PARALLEL_HIT));
    const client = await liveSearchClient(env.DB as never, env as never);
    expect(client).not.toBeNull();
    expect(client?.tier).toBe("pl+tv");
    await client?.search("roster");
    expect(seen[0].url.startsWith("https://api.parallel.ai")).toBe(true);
  });

  it("queries Tavily first when the installation orders it first", async () => {
    const env = makeEnv({
      TAVILY_API_KEY: "tvly-test-key",
      PARALLEL_API_KEY: "parallel-test-key",
    });
    await setupWithProviders(env, [TAVILY, PARALLEL]);
    const seen = stubProviders(() => json(TAVILY_HIT));
    const client = await liveSearchClient(env.DB as never, env as never);
    expect(client?.tier).toBe("tv+pl");
    await client?.search("roster");
    expect(seen[0].url.startsWith("https://api.tavily.com")).toBe(true);
  });
});

describe("provider key entry for search providers", () => {
  function stubKeyEntry(probe: () => Response) {
    const puts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.tavily.com/search" || url === "https://api.parallel.ai/v1/search") {
        return probe();
      }
      if (url.includes("/workers/scripts/") && url.includes("/secrets")) {
        puts.push(String(init?.body));
        return json({ success: true });
      }
      return new Response("unexpected", { status: 500 });
    });
    return puts;
  }

  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      cf_token: "cf-secret-token",
      account_id: "acct-123",
      script_name: "surveyor",
      kind: "tavily",
      label: "tv",
      model: "search",
      secret_slot: "TAVILY_API_KEY",
      api_key: "tvly-secret-xyz",
      ...over,
    });

  async function providersInState(env: Record<string, unknown>) {
    const state = (await (
      await callApp(env, "/api/setup", { headers: auth })
    ).json()) as { providers: Array<Record<string, unknown>> };
    return state.providers;
  }

  it("accepts a Tavily key, probes it, and stores the entry with search tags", async () => {
    const puts = stubKeyEntry(() => json(TAVILY_HIT));
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: body({ capabilities: ["search"] }),
    });
    expect(res.status).toBe(200);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toContain("tvly-secret-xyz");
    const providers = await providersInState(env);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      kind: "tavily",
      secret_slot: "TAVILY_API_KEY",
      capabilities: ["search"],
    });
    const dump = JSON.stringify(
      await (env.DB as FakeD1).prepare("SELECT * FROM setup_state").all(),
    );
    expect(dump).not.toContain("tvly-secret-xyz");
  });

  it("accepts a Parallel key and defaults its tags to search and extract", async () => {
    stubKeyEntry(() => json(PARALLEL_HIT));
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: body({
        kind: "parallel",
        label: "pl",
        secret_slot: "PARALLEL_API_KEY",
        api_key: "parallel-secret-xyz",
      }),
    });
    expect(res.status).toBe(200);
    const providers = await providersInState(env);
    expect(providers[0]).toMatchObject({
      kind: "parallel",
      capabilities: ["search", "extract"],
    });
  });

  it("stores nothing when the provider rejects the key", async () => {
    const puts = stubKeyEntry(() => json({ detail: "bad key" }, 401));
    const env = makeEnv();
    const res = await callApp(env, "/api/providers/key", {
      method: "POST",
      headers: auth,
      body: body(),
    });
    expect(res.status).toBe(422);
    expect(puts).toHaveLength(0);
    expect(await providersInState(env)).toEqual([]);
  });
});

describe("save-time search probes", () => {
  it("names the provider without echoing the key on failure", async () => {
    stubProviders(() => json({ detail: "nope" }, 401));
    const result = await probeSearchKey("parallel", "parallel-secret-xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/parallel/);
      expect(result.error).not.toContain("parallel-secret-xyz");
    }
  });
});
