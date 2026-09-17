// Web search and extraction provider layer (B6): Tavily and Parallel are
// first-class BYOK search/extract options behind the capability-tagged
// registry. A provider result is a pointer — a URL plus a fragment the
// provider chose to show — and never evidence; only an installation-fetched
// snapshot can validate a web citation (ADR-0017, ADR-0018). The chain
// follows the operator's order and falls through on any provider failure,
// so a missing or broken key degrades to the next provider, or to the
// deterministic floor when no search entry is configured at all.

import { z } from "zod";
import { isAllowedProviderBaseUrl } from "./net";

export type SearchProviderKind = "tavily" | "parallel";

/** Fixed provider hosts. They are constants, not operator input, and each
 *  is checked against the worker destination policy before use. */
export const SEARCH_BASE_URLS: Record<SearchProviderKind, string> = {
  tavily: "https://api.tavily.com",
  parallel: "https://api.parallel.ai",
};

export interface SearchEntry {
  kind: string;
  label: string;
  secret_slot: string;
  model?: string;
  capabilities?: string[];
}

/** A provider search result: a lead to re-fetch and snapshot, never a
 *  citation. `snippet` is provider text at an unrecorded fetch time. */
export interface SearchPointer {
  url: string;
  title: string;
  snippet: string;
  published: string | null;
}

/** Provider-processed page content: a lead the engine may read, but the
 *  evidence copy is still the installation's own snapshot. */
export interface ExtractLead {
  url: string;
  title: string;
  text: string;
}

export interface SearchClient {
  tier: string;
  search(query: string): Promise<SearchPointer[]>;
  extract(url: string): Promise<ExtractLead | null>;
}

/** Every configured provider failed. Callers degrade to the deterministic
 *  floor rather than treating the failure as an empty result. */
export class SearchUnavailableError extends Error {
  constructor(detail: string) {
    super(`search providers unavailable: ${detail}`);
    this.name = "SearchUnavailableError";
  }
}

export type ProbeResult = { ok: true } | { ok: false; error: string };

const REQUEST_TIMEOUT_MS = 20_000;

function isSearchKind(kind: string): kind is SearchProviderKind {
  return kind === "tavily" || kind === "parallel";
}

function baseFor(kind: string): string | null {
  if (!isSearchKind(kind)) return null;
  const base = SEARCH_BASE_URLS[kind];
  return isAllowedProviderBaseUrl(base) ? base : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    // The key rides on the first hop only: a redirect would carry it to a
    // destination the base-URL policy never checked.
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const TavilySearchSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().url(),
        title: z.string().optional(),
        content: z.string().optional(),
        published_date: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const TavilyExtractSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().url(),
        raw_content: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const ParallelSearchSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().url(),
        title: z.string().optional(),
        excerpts: z.array(z.string()).optional(),
        publish_date: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const ParallelExtractSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().url(),
        title: z.string().optional(),
        excerpts: z.array(z.string()).optional(),
        full_content: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

async function tavilySearch(
  fetchImpl: typeof fetch,
  base: string,
  key: string,
  query: string,
): Promise<SearchPointer[]> {
  const raw = await postJson(
    fetchImpl,
    `${base}/search`,
    { authorization: `Bearer ${key}` },
    {
      query,
      max_results: 10,
      search_depth: "basic",
      // Provider answers are model text: never requested, never evidence.
      include_answer: false,
      include_raw_content: false,
    },
  );
  const parsed = TavilySearchSchema.safeParse(raw);
  if (!parsed.success) throw new Error("unparseable search response");
  return (parsed.data.results ?? []).map((r) => ({
    url: r.url,
    title: r.title ?? "",
    snippet: r.content ?? "",
    published: r.published_date ?? null,
  }));
}

async function tavilyExtract(
  fetchImpl: typeof fetch,
  base: string,
  key: string,
  url: string,
): Promise<ExtractLead | null> {
  const raw = await postJson(
    fetchImpl,
    `${base}/extract`,
    { authorization: `Bearer ${key}` },
    { urls: [url] },
  );
  const parsed = TavilyExtractSchema.safeParse(raw);
  if (!parsed.success) throw new Error("unparseable extract response");
  const hit = (parsed.data.results ?? []).find((r) => r.url === url);
  if (!hit || !hit.raw_content) return null;
  return { url: hit.url, title: "", text: hit.raw_content };
}

async function parallelSearch(
  fetchImpl: typeof fetch,
  base: string,
  key: string,
  query: string,
): Promise<SearchPointer[]> {
  const raw = await postJson(
    fetchImpl,
    `${base}/v1/search`,
    { "x-api-key": key },
    {
      search_queries: [query],
      mode: "fast",
      advanced_settings: { max_results: 10 },
    },
  );
  const parsed = ParallelSearchSchema.safeParse(raw);
  if (!parsed.success) throw new Error("unparseable search response");
  return (parsed.data.results ?? []).map((r) => ({
    url: r.url,
    title: r.title ?? "",
    snippet: (r.excerpts ?? []).join(" "),
    published: r.publish_date ?? null,
  }));
}

async function parallelExtract(
  fetchImpl: typeof fetch,
  base: string,
  key: string,
  url: string,
): Promise<ExtractLead | null> {
  const raw = await postJson(
    fetchImpl,
    `${base}/v1/extract`,
    { "x-api-key": key },
    { urls: [url], advanced_settings: { full_content: true } },
  );
  const parsed = ParallelExtractSchema.safeParse(raw);
  if (!parsed.success) throw new Error("unparseable extract response");
  const hit = (parsed.data.results ?? []).find((r) => r.url === url);
  if (!hit) return null;
  const text = hit.full_content ?? (hit.excerpts ?? []).join("\n\n");
  if (!text) return null;
  return { url: hit.url, title: hit.title ?? "", text };
}

/** What each run needs: an adapter, the fixed host and the operator's key. */
interface Runner {
  kind: SearchProviderKind;
  base: string;
  key: string;
}

/**
 * Capability-tagged search chain over the operator's order. Any provider
 * failure — missing secret, disallowed host, transport error, non-2xx or an
 * unparseable body — falls through to the next entry; the chain reports
 * itself unavailable only when every entry failed. An empty search result
 * is a valid answer and does not fall through. Extraction treats a provider
 * that has no content for the URL as a miss, so a second provider may still
 * produce the lead.
 */
export function buildSearchClient(
  entries: SearchEntry[],
  secrets: (slot: string) => string | undefined,
  fetchImpl: typeof fetch = fetch,
): SearchClient {
  const runners: Runner[] = [];
  for (const e of entries) {
    if (!isSearchKind(e.kind)) continue;
    const base = baseFor(e.kind);
    if (!base) continue;
    const key = secrets(e.secret_slot);
    if (!key) continue;
    runners.push({ kind: e.kind, base, key });
  }

  return {
    tier: entries.map((e) => e.label).join("+") || "none",
    async search(query: string): Promise<SearchPointer[]> {
      let lastError = "no search providers configured";
      for (const r of runners) {
        try {
          return r.kind === "tavily"
            ? await tavilySearch(fetchImpl, r.base, r.key, query)
            : await parallelSearch(fetchImpl, r.base, r.key, query);
        } catch (err) {
          lastError = `${r.kind}: ${message(err)}`;
        }
      }
      throw new SearchUnavailableError(lastError);
    },
    async extract(url: string): Promise<ExtractLead | null> {
      let lastError = "no search providers configured";
      let missed = false;
      for (const r of runners) {
        try {
          const lead =
            r.kind === "tavily"
              ? await tavilyExtract(fetchImpl, r.base, r.key, url)
              : await parallelExtract(fetchImpl, r.base, r.key, url);
          if (lead) return lead;
          missed = true;
          lastError = `${r.kind}: no content`;
        } catch (err) {
          lastError = `${r.kind}: ${message(err)}`;
        }
      }
      if (missed) return null;
      throw new SearchUnavailableError(lastError);
    },
  };
}

/**
 * Save-time probe for a search-provider key: one cheap call on the provider's
 * search endpoint. Treated like the chat-provider probe — the key value is
 * used in flight and never echoed into the result.
 */
export async function probeSearchKey(
  kind: SearchProviderKind,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const base = SEARCH_BASE_URLS[kind];
  if (!baseFor(kind)) {
    return { ok: false, error: `${kind} base URL not allowed` };
  }
  try {
    if (kind === "tavily") {
      await tavilySearch(fetchImpl, base, apiKey, "surveyor key check");
    } else {
      await parallelSearch(fetchImpl, base, apiKey, "surveyor key check");
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${kind} key test call failed: ${message(err)}` };
  }
}
