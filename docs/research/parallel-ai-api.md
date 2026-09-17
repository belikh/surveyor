# Parallel (parallel.ai) — API surfaces, pricing, terms, and deep-research fit

**Date**: 17 September 2026
**Scope**: what Parallel Web Systems publishes as APIs, what each can do, what it costs, what its terms allow, how far it goes beyond web search (deep research, citations, monitoring, entity discovery), and whether it could serve Surveyor's engine v1 as the search layer or the deep-research layer.
**Method**: primary sources only — `parallel.ai`, `docs.parallel.ai` (fetched as markdown and from the full-docs bundle `llms-full.txt`), the published OpenAPI spec, the Customer Terms, Acceptable Use Policy, Privacy Policy, pricing pages, changelog, status page, and the GitHub/npm/PyPI packages. Cloudflare-side claims are from Cloudflare's own docs. Anything that could not be verified from a primary source is marked **[unverified]**.
**Status**: research note for a decision not yet made; no production code changes.
**Companions**: `docs/research/web-research-integration.md` (§1 provider landscape, §2 provenance design, §5 shortlist) and `docs/research/competitor-landscape.md` §4 (deep-research products).

**Conventions**: "BYOK-on-Workers" means the operator holds the provider key and a Worker makes the call with the standard `fetch` API. "Customer Output" and "Customer IP" are Parallel's defined terms (`https://www.parallel.ai/customer-terms` §1(b)–(e)). Australian English throughout.

---

## 0. What matters first

1. Parallel is not a search-only vendor. It publishes seven stateful or stateless API products — **Search**, **Extract**, **Task** (deep research and enrichment), **Task Group**, **FindAll / Entity Search**, **Monitor**, **Responses** (OpenAI-compatible), plus a beta **Chat** API and a beta **Memory** API (`https://docs.parallel.ai/getting-started/choose-an-api`, `https://docs.parallel.ai/llms.txt`).
2. Its deep research is a real, cited, structured-output product: the Task API returns a `basis` array with per-field citations (`url` + `excerpts`), reasoning, and a confidence rating, and can emit markdown reports with inline citations (`https://docs.parallel.ai/task-api/examples/task-deep-research`, `https://docs.parallel.ai/task-api/guides/access-research-basis`).
3. It is richer than Tavily on capability and cheaper than Tavily on search per request, but its Customer Terms are materially more restrictive than Tavily's for a snapshot-based evidence engine: Parallel may train on Customer IP (§4(b)), output reuse is bounded (§2(b), §2(c)(vi), (xii)), and publishing Parallel-derived content is a grey area. The FAQ's "we never train on your data" directly contradicts the contract — quote both, in §4 below.
4. Cloudflare AI Gateway has a first-class **Parallel provider page**, including a proxy route for any Parallel endpoint and a place in Cloudflare's "Web Search / search-first providers" documentation (`https://developers.cloudflare.com/ai-gateway/usage/providers/parallel/`, `https://developers.cloudflare.com/ai-gateway/usage/web-search/`). This is the strongest Cloudflare-specific finding in this report.
5. Parallel's search output is pointers and excerpts, not evidence copies. It publishes no snapshot, content hash, or raw HTML. Surveyor's citation gate would still require the operator-side Cloudflare fetch/snapshot layer described in `web-research-integration.md` §2.4.

---

## 1. What Parallel is, and every API surface it publishes

### 1.1 The company and product line

Parallel Web Systems Inc. is a Delaware corporation with offices at 735 Emerson Street, Palo Alto, CA 94301 (`https://www.parallel.ai/customer-terms` preamble; `https://www.parallel.ai/privacy-policy` contact block). It describes its product line as "web infrastructure for AI to search, extract, monitor, and reason over the world's information", with Search, Extract, Monitor and deep research marketed as a composable set ("Designed to compose", `https://parallel.ai/`). Its products page and docs group everything as follows:

- Web tools: Search, Extract (`https://docs.parallel.ai/getting-started/choose-an-api`).
- Web agents: Task API (deep research, enrichment), Task Group API, Responses API (`https://docs.parallel.ai/getting-started/overview`).
- Discovery and monitoring: FindAll, Entity Search, Monitor (`https://docs.parallel.ai/getting-started/choose-an-api`).
- Beta: Chat API, Memory API (`https://docs.parallel.ai/resources/changelog`).

The company's own framing is "the web's second user" — infrastructure for AIs rather than humans (`https://parallel.ai/about`).

### 1.2 API surface inventory (current names, from the docs sitemap and OpenAPI spec)

All endpoints are rooted at `https://api.parallel.ai` (`https://docs.parallel.ai/public-openapi.json`, `servers`).

| # | Surface | Endpoint(s) | One-line description |
|---|---|---|---|
| 1 | **Search API** (GA, `/v1`) | `POST /v1/search` | Objective + 2–3 keyword queries → ranked URLs with LLM-optimised excerpts; four modes (`turbo`, `fast`, `basic`, `advanced`). Legacy `/v1beta/search` is maintained only for existing integrations. |
| 2 | **Extract API** (GA, `/v1`) | `POST /v1/extract` | Up to 20 URLs → clean markdown excerpts or full page content; handles JS-rendered pages and PDFs. Legacy `/v1beta/extract` maintained. |
| 3 | **Task API** (deep research + enrichment) | `POST /v1/tasks/runs`; `GET /v1/tasks/runs/{run_id}`, `/input`, `/result`, `/events` | Async web-research agent: plain-language or structured input → structured JSON or markdown, with citations, reasoning and confidence per field. Processors `lite`…`ultra8x`. |
| 4 | **Task Group API** | `POST /v1/tasks/groups`; `GET /v1/tasks/groups/{id}`, `/runs`, `/runs/{run_id}`, `/events` | Batch many Task Runs (up to 1,000 per POST) with group-level status and event streaming. |
| 5 | **Ingest API** | `POST /v1beta/findall/ingest` | Turns a natural-language FindAll objective into a structured spec (`entity_type`, `match_conditions`) for review/editing. |
| 6 | **FindAll API** (beta) | `POST /v1beta/findall/runs`; status, result, schema, `/events`, `/enrich`, `/extend`, `/cancel` | Builds verified entity lists from scratch: generates candidates, evaluates each against match conditions, optionally enriches matched entities. |
| 7 | **Entity Search** (beta) | `POST /v1beta/findall/entity-search` | Fast, synchronous people-and-company search returning a ranked candidate set; optimised for recall, no per-field citations. |
| 8 | **Responses API** | `POST /v1/responses` | OpenAI Responses-compatible endpoint returning a synthesised, cited answer in 5–60 s; one model id `parallel`, tier via `reasoning.effort`. |
| 9 | **Chat API** (beta) | `POST /v1beta/chat/completions` | OpenAI ChatCompletions-compatible chat with live web research; supports `speed` plus research models. |
| 10 | **Monitor API** (GA) | `POST /v1/monitors`; GET/update/cancel/trigger/events | Scheduled natural-language query that watches the web and pushes detected changes to a webhook (or is polled); `event_stream` and `snapshot` monitor types. |
| 11 | **Memory API** (beta) | `POST /v1beta/memory/retrieve`, `/evict`, `/clear` | Search and manage past Task/Monitor/FindAll results so agents can build on prior work; opt-in per request via `memory_scope_key`. |
| 12 | **Service / Account API** | `https://api.parallel.ai/account/service/{keys,apps,balance}` + device OAuth at `https://platform.parallel.ai/getServiceKeys/...` | Programmatic management of API keys, apps and prepaid balance; OAuth 2.0 device flow (`RFC 8628`) for account access. |
| 13 | **MCP servers** | `https://search.parallel.ai/mcp` (free, no key), `https://task-mcp.parallel.ai/mcp` (key required) | Hosted Streamable-HTTP MCP servers exposing `web_search`/`web_fetch` (Search MCP) and `createDeepResearch`/`createTaskGroup`/`getStatus`/`getResultMarkdown` (Task MCP). |
| 14 | **Data integrations** | BigQuery, Snowflake, DuckDB, Polars, Spark, Supabase | SQL-native UDFs that call Parallel enrichment from warehouse/dataframe tools. |
| 15 | **Crawler / index** | ShapBot, `https://index.parallel.ai` | Not a developer API: Parallel's crawler (with robots.txt guidance) and a content-owner attribution/compensation platform. |

Non-API surfaces documented alongside these: a CLI, agent skills, an OpenCode plugin, a Cursor plugin, LangChain/LiteLLM/n8n/Zapier/Google-Sheets integrations, and an OAuth provider for embedding (`https://docs.parallel.ai/llms.txt` §Integrations).

The published OpenAPI document records the paths above and an API version of `0.1.2` (`https://docs.parallel.ai/public-openapi.json`). FindAll, Entity Search, Chat and Memory are labelled public beta with "30 days notice before any breaking changes" (`https://docs.parallel.ai/findall-api/findall-quickstart`, `https://docs.parallel.ai/findall-api/entity-search`).

---

## 2. API-by-API detail

Latency, shape and pricing below are from the official pricing page (`https://docs.parallel.ai/getting-started/pricing`) and product docs unless stated otherwise. Rate limits are from `https://docs.parallel.ai/getting-started/rate-limits`.

### 2.1 Search API

**What it does.** Replaces multiple keyword searches with one call: an optional natural-language `objective` plus required `search_queries`, returning ranked URLs, titles, `publish_date` and compressed `excerpts` shaped for a model (`https://docs.parallel.ai/search/search-quickstart`). `search_queries` is the only required field; a single query string is a valid request (`https://docs.parallel.ai/search/migrate-to-parallel`).

**Request shape** (from the quickstart and advanced-settings pages):

```json
{
  "objective": "natural-language intent (optional)",
  "search_queries": ["2-3 keyword queries, 3-6 words each"],
  "mode": "turbo | fast | basic | advanced",
  "max_chars_total": 0,
  "session_id": "…",
  "client_model": "…",
  "advanced_settings": {
    "source_policy": { "include_domains": [], "exclude_domains": [], "after_date": "YYYY-MM-DD" },
    "fetch_policy": { "max_age_seconds": 3600 },
    "excerpt_settings": { "max_chars_per_result": 10000 },
    "location": "au",
    "max_results": 10
  }
}
```

**Response shape** (`https://docs.parallel.ai/search/search-quickstart`): `search_id`, `results[]` (each `url`, `title`, `publish_date`, `excerpts[]`), `warnings`, `usage[]`, `session_id`.

**Sync/async and streaming.** Synchronous JSON; no webhooks or SSE for Search itself.

**Modes and latency** (`https://docs.parallel.ai/search/modes`, `https://docs.parallel.ai/getting-started/pricing`):

| Mode | Latency | Cost/1k (10 results) | Notes |
|---|---|---|---|
| `turbo` | ~200 ms p50 | $1 | English + Japanese only; no domain/path-prefix filters |
| `fast` | ~700 ms | $1 | Recommended default for most agents |
| `basic` | ~1 s | $5 | Extended snippets |
| `advanced` (default) | ~3 s | $5 | Highest-quality retrieval/compression |

**Result caps.** `max_results` defaults to 10 and public modes cap at 20; higher values are reduced with a warning (`https://docs.parallel.ai/search/advanced-search-settings`).

**Auth.** `x-api-key: $PARALLEL_API_KEY` (not Bearer — the migration guide calls this out explicitly: a Tavily-style Bearer header returns 401) (`https://docs.parallel.ai/search/migrate-to-parallel`).

**Rate limit.** 600 requests/min (`https://docs.parallel.ai/getting-started/rate-limits`).

**Workers viability.** Single stateless JSON POST over https; the official TypeScript SDK lists Cloudflare Workers as a supported runtime with zero runtime dependencies (`https://github.com/parallel-web/parallel-sdk-typescript`, README Requirements). Runs from `fetch`.

### 2.2 Extract API

**What it does.** Converts public URLs to clean markdown, "including JavaScript-heavy pages and PDFs", returning objective-focused excerpts or full content; up to 20 URLs per call (`https://docs.parallel.ai/extract/extract-quickstart`).

**Request shape:** `urls` (required), optional `objective`, `search_queries`, `max_chars_total`, `advanced_settings.fetch_policy` (`max_age_seconds`, `timeout_seconds`, `disable_cache_fallback`), `advanced_settings.excerpt_settings.max_chars_per_result`, `advanced_settings.full_content` (`https://docs.parallel.ai/extract/advanced-extract-settings`).

**Response shape:** `extract_id`, `results[]` (`url`, `title`, `publish_date`, `excerpts[]`, optional `full_content`), `errors[]` (`url`, `error_type`), `warnings`, `usage`, `session_id` (`https://docs.parallel.ai/extract/extract-quickstart`).

**Sync/async.** Synchronous; no webhooks.

**Latency.** Docs pricing: "1–20 s". Advanced settings: fresh (live) fetches "may take up to a minute"; marketing pricing says `< 3 s` cached and `60–90 s` live (`https://docs.parallel.ai/getting-started/pricing`, `https://parallel.ai/pricing`). Treat live fetch as up to ~90 s and use Workers `fetch` with a timeout.

**Auth.** `x-api-key`. **Rate limit.** 600/min. **Workers viability.** Single POST; fine.

### 2.3 Task API (deep research and enrichment)

**What it does.** "Combines AI inference with web search and live crawling to turn complex research tasks into repeatable workflows", with citations and confidence levels (`https://docs.parallel.ai/task-api/task-quickstart`). Two documented modes of use: enrichment of structured input, and Deep Research from a plain-language question (`https://docs.parallel.ai/task-api/examples/task-deep-research`).

**Processors** (depth/price/latency; per 1,000 runs) (`https://docs.parallel.ai/getting-started/pricing`, `https://docs.parallel.ai/task-api/guides/choose-a-processor`):

| Processor | Cost/1k | Latency | Strength |
|---|---|---|---|
| `lite` | $5 | 10–60 s | Basic metadata, fallback |
| `base` | $10 | 15–100 s | Reliable standard enrichments |
| `core` | $25 | 60 s–5 min | Cross-referenced, moderately complex outputs |
| `core2x` | $50 | 60 s–10 min | Higher-complexity cross-referenced outputs |
| `pro` | $100 | 2–10 min | Exploratory web research / Deep Research |
| `ultra` | $300 | 5–25 min | Advanced multi-source deep research |
| `ultra2x` | $600 | 5–50 min | Difficult deep research |
| `ultra4x` | $1,200 | 5–90 min | Very difficult deep research |
| `ultra8x` | $2,400 | 5 min–2 hr | Most difficult deep research |

Fast variants (`-fast` suffix) cost the same and shave latency at the expense of data freshness (`https://docs.parallel.ai/getting-started/pricing`). You are billed only for successfully completed runs (same page).

**Request shape:** `input` (string or JSON, required), `processor` (required), optional `task_spec` (input/output schemas), `source_policy`, `previous_interaction_id`, `mcp_servers`, `enable_events`, `webhook`, `metadata`, `memory_scope_key` (`https://docs.parallel.ai/public-openapi.json` `POST /v1/tasks/runs`; `https://docs.parallel.ai/task-api/webhooks`). Output schemas are text string, JSON schema, text schema, or auto (`https://docs.parallel.ai/task-api/task-quickstart`).

**Async model:** creating a run returns a `run_id` immediately (HTTP 202); outcomes are retrieved by polling, webhooks, or SSE (`https://docs.parallel.ai/task-api/examples/task-deep-research`). Run states `queued → running → completed | failed` (`https://docs.parallel.ai/task-api/guides/execute-task-run`).

**Webhooks:** `event_types: ["task_run.status"]` only; the payload carries the run object, not the results — "you must make a separate API call to retrieve the actual research results" (`https://docs.parallel.ai/task-api/webhooks`, `https://docs.parallel.ai/task-api/examples/task-deep-research`). Delivery uses the Standard Webhooks spec, HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw_body}`, with 5 s initial retry delay, exponential backoff, and retries over 48 hours (`https://docs.parallel.ai/resources/webhook-setup`). The docs include a copy-paste Cloudflare Workers verifier using `crypto.subtle` (same page).

**SSE:** `enable_events: true` then `GET /v1/tasks/runs/{run_id}/events` (`Accept: text/event-stream`) streams `task_run.state`, `task_run.progress_stats`, `task_run.progress_msg.*` (plan, tool_call, result, exec_status, search) and error events; streams stay open up to 570 s and "are not resumable — there are no sequence numbers or cursors"; the final status event carries the complete output for completed runs (`https://docs.parallel.ai/task-api/task-sse`).

**Auth.** `x-api-key`. **Rate limit.** 2,000 requests/min (each run created counts) (`https://docs.parallel.ai/getting-started/rate-limits`).

**Workers viability.** Creating a run is a single POST. Blocking on `result` for `pro` (up to 10 min) or `ultra` (up to 2 hr) is explicitly discouraged by Parallel: "Blocking an HTTP connection for hours is not the design… Register a webhook at create time" (`https://docs.parallel.ai/getting-started/overview`, Task setup prompt). Cloudflare Workers impose no wall-clock limit on HTTP request duration, but CPU time is limited (10 ms Free; default 30 s Paid, configurable to 5 min) and waiting on network does not consume CPU (`https://developers.cloudflare.com/workers/platform/limits/`); the natural Worker pattern is create → `waitUntil`/Queue → poll or webhook.

### 2.4 Task Group API

Batch wrapper: `POST /v1/tasks/groups`, then up to 1,000 runs per `POST /v1/tasks/groups/{id}/runs`; `GET /v1/tasks/groups/{id}` gives a progress snapshot and `/runs` streams run state over SSE; `/events` is resumable via `event_id` (`https://docs.parallel.ai/task-api/group-api`). Retention note, quoted in full in §4.4: runs are "subject to your account's data-retention configuration" (`https://docs.parallel.ai/task-api/group-api`).

### 2.5 FindAll, Ingest, and Entity Search (beta)

- **Ingest**: natural language → structured spec (`entity_type`, `match_conditions`, suggested generator) which the caller can and should edit before creating a run (`https://docs.parallel.ai/findall-api/findall-quickstart`).
- **FindAll**: asynchronous run with `objective`, `entity_type`, `match_conditions[]`, `generator` (`preview`/`base`/`core`/`pro`) and `match_limit` (5–1,000). Three stages: generate candidates → evaluate against conditions → enrich matched candidates. Results carry `candidate_id`, `name`, `url`, `description`, `match_status`, per-condition `output`, and a `basis` array with citations/reasoning/confidence (`https://docs.parallel.ai/findall-api/findall-quickstart`, `https://docs.parallel.ai/findall-api/core-concepts/findall-candidates`). Async surfaces: polling, SSE, webhooks (candidate + run events), extend, cancel, refresh with `exclude_list` (`https://docs.parallel.ai/llms.txt`).
- **Entity Search**: synchronous `POST /v1beta/findall/entity-search` with `entity_type` (`people`/`companies`), `objective`, `match_limit` (5–1,000, default 100) → `entity_set_id` + ranked `entities` (`name`, `url`, `description`). Explicitly recall-optimised and without per-field citations (`https://docs.parallel.ai/findall-api/entity-search`).

**Auth.** `x-api-key`. **Rate limits.** Entity Search 600/min; FindAll 300/hour per the docs table (`https://docs.parallel.ai/getting-started/rate-limits`) — note the marketing pricing page says FindAll 25/hour (`https://parallel.ai/pricing`); the discrepancy is unresolved.

### 2.6 Responses API (OpenAI-compatible, latency-sensitive)

**What it does.** OpenAI Responses wire format at `POST /v1/responses` with a single model id `parallel`; `reasoning.effort` selects `low` (~5–10 s, $10/1k), `medium` (~15–20 s, $50/1k, default) or `high` (~30–60 s, $250/1k). Answers are grounded in automatic live web research and carry OpenAI-style `url_citation` annotations with `url`, `title`, `start_index`, `end_index` (`https://docs.parallel.ai/responses-api/responses-quickstart`, `https://docs.parallel.ai/responses-api/features/citations`).

**Compatibility notes** (`https://docs.parallel.ai/responses-api/openai-compatibility`): `base_url`, `api_key`, `model` are the only changes; `tools`, `tool_choice`, `temperature`, `store` etc. are accepted but ignored; `background: true` is rejected with a pointer to the Task API; responses are always stored server-side so `previous_response_id` works. **Auth.** `Authorization: Bearer` (OpenAI SDK convention). **Rate limit.** 300/min per the marketing pricing table (`https://parallel.ai/pricing`); the docs rate-limit page omits Responses **[partially verified]**.

**Workers viability.** Single POST; it is just OpenAI's wire shape over `fetch`, so no SDK dependency is required.

### 2.7 Chat API (beta)

`POST /v1beta/chat/completions`, OpenAI ChatCompletions-compatible, streaming text/JSON, aimed at low-latency interactive use; supports a `speed` model plus research models (Lite/Base/Core) with full Basis verification (`https://docs.parallel.ai/resources/changelog`, entries dated 30 May 2025 and 15 January 2026). **Rate limit.** 300/min (`https://docs.parallel.ai/getting-started/rate-limits`).

### 2.8 Monitor API (GA)

Define a query once; Monitor runs on a schedule (`"1h"`–`"30d"`) and pushes detected changes to a webhook or via an events endpoint. Two types: `event_stream` (watch a query) and `snapshot` (diff a structured Task Run output across executions). Event payloads carry `event_id`, `event_date`, `output.content`, and a `basis` with citations/reasoning/confidence; `advanced_settings` supports `source_policy` and `location` (`https://docs.parallel.ai/monitor-api/monitor-quickstart`, `https://docs.parallel.ai/monitor-api/quickstart-snapshot`). Follow-up tasks can be triggered from a monitor event by passing `output.content` as `input` and `event_id` as `previous_interaction_id` (`https://docs.parallel.ai/monitor-api/monitor-task`). **Auth.** `x-api-key`. **Rate limit.** 300/min. **Pricing.** $3/1k checks (`lite`) or $10/1k (`base`) (`https://docs.parallel.ai/getting-started/pricing`).

### 2.9 Memory API (beta)

Application memory is opt-in per request via `memory_scope_key` on Task, FindAll, or Monitor creation; `POST /v1beta/memory/retrieve` ranks past runs by query (or returns recent), `/evict` removes one source, `/clear` deletes a bank (`https://docs.parallel.ai/resources/memory`). Interactions are **not available** for Zero Data Retention customers (`https://docs.parallel.ai/task-api/guides/interactions`).

### 2.10 MCP servers, CLI, and SDKs

- **Search MCP** (`https://search.parallel.ai/mcp`): `web_search` + `web_fetch`, free without an API key; anonymous requests run in `fast` mode, and excerpts are capped at roughly 25,000 characters per call; `/mcp-oauth` requires authentication and is the endpoint to use for organisation-wide or ZDR deployments (`https://docs.parallel.ai/integrations/mcp/search-mcp`).
- **Task MCP** (`https://task-mcp.parallel.ai/mcp`): `createDeepResearch`, `createTaskGroup`, `getStatus`, `getResultMarkdown`; requires a key; async by design (`https://docs.parallel.ai/integrations/mcp/task-mcp`).
- **TypeScript SDK** `parallel-web` v1.3.3, MIT, generated with Stainless, zero runtime dependencies; README states supported runtimes include **Cloudflare Workers**, Vercel Edge, Node 20+, Deno, Bun (`https://www.npmjs.com/package/parallel-web`, `https://github.com/parallel-web/parallel-sdk-typescript`).
- **Python SDK** `parallel-web` v1.3.3, MIT, Python ≥3.9 (`https://pypi.org/project/parallel-web/`).
- **Vercel AI SDK tool package** `@parallel-web/ai-sdk-tools` v1.0.0 declares peer dependency `ai@^6.0.0` (`https://registry.npmjs.org/@parallel-web/ai-sdk-tools`). Surveyor's stack is `ai@7`; the drop-in tool package will not install cleanly without `--legacy-peer-deps` or a version bump, so the raw SDK/HTTP path is the safe integration for us.
- **GitHub org**: `https://github.com/parallel-web` (SDKs, cookbook, Task MCP, Search MCP, agent skills, LangChain/Google-ADK packages, CLI tools).

### 2.11 Auth model and rate limits, consolidated

One organisation-level API key created on `https://platform.parallel.ai`, passed as `x-api-key` (Search/Extract/Task/FindAll/Monitor) or `Authorization: Bearer` (Responses, Account API, MCP). Keys can be created programmatically per app via the Service API (`https://api.parallel.ai/account/service/keys`), and apps are first-class (`/account/service/apps`); balance can be read and topped up (`/account/service/balance`) (`https://docs.parallel.ai/llms.txt`, Service API section). Spend limits are **notify-only and never block requests** (`https://docs.parallel.ai/resources/faqs`). Default rate limits per the docs table: Search 600/min, Extract 600/min, Tasks 2,000/min, Chat 300/min, FindAll 300/hr, Entity Search 600/min, Monitor 300/min (`https://docs.parallel.ai/getting-started/rate-limits`).

---

## 3. Pricing and free tier

**Official docs pricing** (`https://docs.parallel.ai/getting-started/pricing`):

| Product | Price | Timing |
|---|---|---|
| Search | $1/1k requests (`turbo`/`fast`) or $5/1k (`basic`/`advanced`), includes 10 results; +$1/1k extra results | 200 ms–3 s, sync |
| Extract | $1/1k URLs | 1–20 s, sync |
| Task | $5–$2,400/1k successful runs (per processor, table in §2.3) | 10 s–2 hr, async |
| Responses | $10–$250/1k successful requests by `reasoning.effort` | 5–60 s, sync |
| Monitor | $3–$10/1k checks | ongoing, async |
| FindAll | $0.25 fixed + $0.03/match (`base`); `core` $2 + $0.15; `pro` $10 + $1; `preview` $0.10, free matches | 10 s–2 hr, async |
| Entity Search | $5/1k requests incl. 100 results; +$0.05/1k extra results | 1–3 s, sync |

**Free tier.** The marketing pricing page advertises "Run up to 5,000 requests per month for free" and "Earn up to $80 at signup + $5 in free credits per month" (`https://parallel.ai/pricing`). The homepage FAQ explains: "New accounts get a signup credit, and every account gets a recurring free monthly allowance of $5. Free credit is always spent before any paid balance" (`https://parallel.ai/`, FAQ). The $5/month credit requires "a credit card on file", expires at month end, and marketplace/postpaid organisations are excluded (`https://parallel.ai/blog/free-tier-parallel`, `https://docs.parallel.ai/resources/changelog` dated 15 July 2026). There is also a qualified-startups credit of up to $250 (`https://parallel.ai/pricing`). The **Search MCP is free with no account or key** (`https://docs.parallel.ai/integrations/mcp/search-mcp`).

**Enterprise-only.** Zero Data Retention (ZDR), Data Protection Agreements, Single Sign-On, custom rate limits, dedicated support (`https://parallel.ai/pricing`). ZDR is described as a "deployment mode in which Parallel does not retain request or response data after a run completes" and disables interactions and other stateful features (`https://docs.parallel.ai/getting-started/glossary`); on Google Cloud Marketplace it is a separate listing that requires `enable_zero_data_retention: true` per request and is "not available with Bring Your Own Key" in that marketplace flow (`https://docs.parallel.ai/integrations/google-gemini-enterprise`).

**Marketing vs docs discrepancies** (both live on 17 September 2026): FindAll rate limit 25/hr vs 300/hr; Extract latency `<3 s cached / 60–90 s live` vs `1–20 s`; Task latency bands differ slightly (e.g. `core2x` 2–5 min vs 60 s–10 min). Cite the docs page for engineering, the marketing page for the free-tier offer.

---

## 4. Terms of service and data handling

Two documents matter: the **website** Terms of Use (`https://parallel.ai/terms-of-service`, "rules and restrictions that govern your use of our websites") and the **Customer Terms and Conditions** (`https://www.parallel.ai/customer-terms`), which govern API use. The FAQ links to the latter for API questions (`https://docs.parallel.ai/resources/faqs`). Section numbers below are from the Customer Terms. The per-provider storage, caching and republication decisions drawn from these clauses are recorded in `docs/research/provider-terms-review.md` (draft for human legal sign-off).

### 4.1 Ownership and what you may do with output

§1(c)–(e) define Customer Input, Customer Output, and Customer IP (inputs + outputs). §4(b): "As between the Parties, Customer retains all right, title and interest in and to the Customer IP, except for the license granted to Parallel in this Section 4(b)."

The storage/resharing limits are in §2(b):

> "Customer may modify, adapt, or create derivative works based on Customer Output and incorporate Customer Output (and such derivative works) into materials that Customer provides to its End Customers, provided that (i) Customer Output generated from one query shall be primarily for the use of one End Customer only, and shall not be copied, cached, stored, or made available to other End Customers or other third parties; (ii) Customer shall not copy, cache, or store any significant portion of any Customer Output to create the AI and Data Selling Services (as defined in Section 2(c) below)."

And §2(c)(vi):

> "use the Services or any Customer Output to (A) create synthetic training data to develop or train a language model or any other machine learning model, or (B) create databases, data brokerage, data selling/reselling businesses, or related products or services, whether competitive with the Services or not (all of the foregoing collectively, the 'AI and Data Selling Services'), or (C) otherwise for any competitive purposes;"

And §2(c)(xii):

> "intentionally or knowingly diverge requests of Authorized Users away from the Services (such as by making available Customer Outputs from previous queries for future uses, or incorporating Customer Outputs into an AI and Data Selling Services);"

**Reading for Surveyor.** For a single-operator, BYOK investigative tool the operator is the only End Customer, so storing and re-reading their own Task/Search outputs for the same investigation appears within §2(b)(i) as written, and re-serving them to a different customer is clearly not. But the engine's snapshot-and-cite design should be checked against §2(c)(xii) ("previous queries for future uses") and §2(b)(ii) ("significant portion… to create databases") by the operator's counsel: the clauses are drafted against resellers, yet their wording is broad. Publishing a report that "incorporates" Parallel output to a public readership is a grey area under §2(b) because a public audience has not "agreed to be bound by" Parallel's terms as End Customers are defined in §1(f). The defensible posture is the one already recommended in `web-research-integration.md` §2.4: treat provider output as pointers, keep the operator-side snapshot as the evidence copy, keep snapshots private, and publish only the operator's own citations — not Parallel's excerpts.

### 4.2 Model training and data improvement

This is the sharpest contradiction in Parallel's public materials. The FAQ says:

> "Will you train models on my data? Never. Inputs and outputs remain yours. We do not use customer data to train any models." (`https://docs.parallel.ai/resources/faqs`)

The Customer Terms say otherwise. §4(b):

> "Customer grants Parallel a nonexclusive, worldwide, royalty-free, perpetual, sublicensable license to use, copy, reproduce, distribute, and make derivative works of Customer IP for the purpose of (i) performing under this Agreement, (ii) internally (by itself or through its contractors/vendors acting on its behalf) developing and improving the Services and for other development, diagnostic, quality assurance, and corrective purposes… and (iii) creating Aggregated De-Identified Data…"

with an explicit bullet:

> "Parallel may use Customer IP to train and improve the machine learning and other artificial intelligence models used to provide the Services. Customer IP used for training is not linked to any individual during training."

So the contract permits training on Customer IP (described as de-linked), while the FAQ promises it never happens. For an investigative engine handling private submissions, the contract text is the conservative assumption, and the FAQ is not a warranty. The Account API also grants Parallel usage data rights, and §4(b) permits sharing "through its contractors/vendors" — a subprocessor arrangement without a published subprocessor list (see §4.4).

### 4.3 Data protection, high-risk uses, and prohibitions relevant to investigation

- **Personal data**: "Before Customer use the Services to process any 'personal data'… Customer shall separately execute Parallel's Data Processing Addendum made available by Parallel" (§4(d)) (`https://www.parallel.ai/customer-terms`). The DPA is not published at any discoverable URL **[unverified]** — request it from Parallel. The privacy policy says business-customer API content is processed "as a processor on behalf of the customer under our Data Processing Addendum" (`https://www.parallel.ai/privacy-policy`).
- **High-risk uses**: §8(e) prohibits using the Services or output "to make automated decisions without human oversight that have a significant adverse impact on individual rights in high-risk areas such as employment, healthcare, finance, legal, housing, insurance or social benefits" (`https://www.parallel.ai/customer-terms`).
- **AUP §1(b)** prohibits uses that "misuse, collect, solicit, or gain access without permission to private information such as non-public contact details, health data, biometric or neural data… or confidential or proprietary data" (`https://www.parallel.ai/acceptable-use-policy`).
- **AUP §2** prohibits "engage in surveillance: tracking, targeting or reporting on identity, facial recognition, covert tracking…" and "engage in law enforcement uses impairing civil rights/liberties"; and automated scoring/decision-making in sensitive areas without human review.
- **AUP §3** makes "legal" a High-Risk Use Case requiring human-in-the-loop review by a qualified professional before dissemination, disclosure to end users, and no misrepresentation of AI authorship (`https://www.parallel.ai/acceptable-use-policy`).

For a workplace-investigation product these are workable but conditioning: the engine already keeps a human approval gate and never auto-publishes (`THREAT-MODEL.md`; `web-research-integration.md` §3.3), which is the posture these clauses demand. The clauses to take seriously are the surveillance framing (an investigative tool that aggregates information about named individuals can drift into it) and the private-information clause (corpus content passed as a task input is the operator's own, but web results about individuals are not). This is a legal-review item, not an engineering one.

### 4.4 Retention, residency, subprocessors, and security claims

- **Retention by Parallel.** The docs define ZDR as a mode with no post-run request/response retention (`https://docs.parallel.ai/getting-started/glossary`), and the Task Group page says runs "are subject to your account's data-retention configuration. Persist any results your application needs after processing; Zero Data Retention (ZDR) deployments do not retain completed run data" (`https://docs.parallel.ai/task-api/group-api`). The default retention window for non-ZDR accounts is **not published [unverified]**.
- **EU data residency.** The privacy policy states: "For business customers that select our EU data residency option, Search API requests sent to the EU endpoint are processed and served within the European Union, and we do not retain request or response content" (`https://www.parallel.ai/privacy-policy`). This covers the **Search API only**; Task/FindAll/Monitor/Responses processing is not described as EU-resident **[unverified]**.
- **Storage location.** FAQ: "All data is encrypted in transit (TLS 1.2+) and at rest in US-based data centers" (`https://docs.parallel.ai/resources/faqs`).
- **Subprocessors.** No published subprocessor list was found; §4(b) permits contractors/vendors acting on Parallel's behalf, and the privacy policy lists service-provider categories only (`https://www.parallel.ai/privacy-policy`, "Service Providers"). Request the list with the DPA **[unverified]**.
- **Security/compliance.** FAQ: "Parallel is SOC-II Type 1 and Type II certified as of April 2025"; full report via the Trust Center (`https://docs.parallel.ai/resources/faqs`; the Vanta-hosted Trust Center is at `https://trust.parallel.ai/`, rendered client-side, so its contents could not be read from a primary static source in this run **[unverified]**).
- **Caching of outputs.** Parallel's own caching guidance warns: "If your inputs could include private customer data, internal documents, or any proprietary context, we do not recommend caching outputs and reusing them across customers" (`https://docs.parallel.ai/task-api/best-practices`). That is a data-leakage warning, not a rights restriction, and does not bar a single-operator store.

---

## 5. Deep research specifics

### 5.1 Does the Task API produce cited research outputs, and in what format?

Yes. Two output shapes:

- **Auto schema** (default for `pro`/`ultra`): structured JSON whose shape the processor determines, plus a `basis` array of `FieldBasis` objects. Each has `field`, `citations[]` (`url`, `excerpts[]`), `reasoning`, and `confidence` (`high`/`medium`/`low`). For arrays, "Per-Element Basis" adds dot-indexed entries such as `key_executives.0` (GA 24 August 2026) (`https://docs.parallel.ai/task-api/guides/access-research-basis`, `https://docs.parallel.ai/resources/changelog`).
- **Text schema** (`output_schema: {type: "text"}`): a markdown report with inline citations and source excerpts; the docs' own summary is that the FieldBasis for text mode "contains a list of citations (with URLs and excerpts) for all sites visited during research. The most relevant citations are included at the base of the report itself, with inline references" (`https://docs.parallel.ai/task-api/examples/task-deep-research`, `https://docs.parallel.ai/resources/changelog` dated 11 September 2025).

A documented `ultra` example returns 124 content fields with 610 citations for a single market-research task (`https://docs.parallel.ai/task-api/examples/task-deep-research`).

### 5.2 Provenance: URLs and snippets, but no snapshots

Citations carry the source **URL** and **text excerpts only** — no page snapshot, retrieval timestamp, content hash, or raw HTML (`https://docs.parallel.ai/task-api/guides/access-research-basis`). The best available approximation of a content copy is the **Extract API with `full_content: true`**, which returns the page's markdown (up to a configurable `max_chars_per_result`), but that is provider-processed text at an unrecorded fetch time, not an immutable capture (`https://docs.parallel.ai/extract/advanced-extract-settings`). Search and Extract also support `fetch_policy.max_age_seconds` to prefer live vs indexed content, but they return no fetch metadata beyond `publish_date` (`https://docs.parallel.ai/extract/extract-quickstart`, `https://docs.parallel.ai/search/advanced-search-settings`). **Consequence**: Parallel cannot supply the evidence copy that `web-research-integration.md` §2.4 requires; the operator-side Cloudflare snapshot (fetch → Workers AI `toMarkdown` → R2 + SHA-256 + timestamp) remains the citation target, and a Parallel citation is a lead to verify, not evidence.

### 5.3 Can inputs include the operator's own documents (corpus grounding)?

Partially, in three ways, none of which is a document index:

1. **As task input.** Task `input` is a string or JSON object; the FAQ says: "You can pass private data into a task as an input variable or post-process the output on your side, but we don't pull it natively" (`https://docs.parallel.ai/resources/faqs`). Deep Research, however, "is optimized for concise research prompts and is not meant for long context inputs. Keep your input under 15,000 characters" (`https://docs.parallel.ai/task-api/examples/task-deep-research`). So a whole corpus cannot be handed to the deep-research path; enrichment input is better suited to structured records.
2. **Via interaction chaining.** `previous_interaction_id` carries prior context forward, which can include prior research outputs (`https://docs.parallel.ai/task-api/guides/interactions`).
3. **Via MCP servers** (`mcp_servers`, up to 10): the Task API can call tools on remote MCP servers during a run. The documented example is Browser Use for login-gated/private web content; any Streamable-HTTP MCP server with tools can be attached (`https://docs.parallel.ai/task-api/mcp-tool-call`, `https://docs.parallel.ai/integrations/browseruse`). This is the only documented path that resembles retrieval over a private source, and it is Parallel pulling from the operator's own server, with the credentials and ToS the operator supplies.

The engine's gated corpus would therefore stay on the Surveyor side: use Parallel for web leads and synthesis, and keep corpus retrieval inside the existing registry/model path.

### 5.4 Domain and path scoping

`source_policy` is supported on **Task, Search and Monitor**, with `include_domains` (hard allow list), `exclude_domains` (applied only when include is empty), and, on Search only, `after_date` (RFC 3339/`YYYY-MM-DD`). Apex domains include subdomains; `example.com/blog` matches the path and its descendants at segment boundaries; bare extensions such as `.gov` are allowed; schemes/ports/query strings are rejected; combined hard limit 200 entries per request. Domain/path prefixes are **not** supported in Search `turbo` mode (`https://docs.parallel.ai/resources/source-policy`, `https://docs.parallel.ai/search/advanced-search-settings`). The docs warn that hard filters "can significantly reduce result quality" and recommend steering via the `objective` instead.

### 5.5 Latency/cost envelope for deep research

`pro` is the cheapest cited Deep Research processor at $100/1k runs and 2–10 min; `ultra` at $300/1k and 5–25 min; `ultra8x` at $2,400/1k and up to 2 hr (`https://docs.parallel.ai/getting-started/pricing`). For interactive use, the Responses API at `high` effort gives a cited answer in ~30–60 s for $250/1k (`https://docs.parallel.ai/responses-api/responses-quickstart`). A single `ultra` run costs about as much as 100 `advanced` searches.

---

## 6. How it compares

### 6.1 Against Tavily (the shortlist's default search layer)

| Dimension | Tavily (from `web-research-integration.md` §1.2, §5) | Parallel |
|---|---|---|
| Search + extract in one key | Yes (`/search`, `/extract`) | Yes (`/v1/search`, `/v1/extract`) |
| Search price | $0.008/credit, 1–2 credits/search (~$8–16/1k) | $1/1k (`turbo`/`fast`) to $5/1k (`basic`/`advanced`) (`https://docs.parallel.ai/getting-started/pricing`) |
| Free tier | 1,000 credits/month, no card | $5/month credits **with card**, plus signup credit; free hosted MCP without a key (`https://parallel.ai/blog/free-tier-parallel`, `https://parallel.ai/pricing`) |
| Search latency | Not stated in the prior report | 200 ms–3 s by mode (`https://docs.parallel.ai/search/modes`) |
| Extract | ≤20 URLs, `raw_content` | ≤20 URLs, excerpts or `full_content` (`https://docs.parallel.ai/extract/extract-quickstart`) |
| Retention terms | No storage prohibition found; query-data improvement opt-out | Output reuse bounded by §2(b); §2(c)(vi) bars AI/data-selling and "databases"; §2(c)(xii) bars diverging requests to cached outputs; training licence in §4(b) |
| Training on customer data | Opt-out setting; §6.5 for AI-Functionality endpoints | FAQ says never; §4(b) says may — contradiction (§4.2 above) |
| Deep research | None (search + extract only) | Task API, Responses API, FindAll, Monitor |
| Workers | Plain JSON | Plain JSON; official TS SDK lists Workers (`https://github.com/parallel-web/parallel-sdk-typescript`) |
| Cloudflare AI Gateway | Not a listed provider | First-class provider page and search-first entry (`https://developers.cloudflare.com/ai-gateway/usage/providers/parallel/`, `https://developers.cloudflare.com/ai-gateway/usage/web-search/`) |

**Verdict.** Parallel is technically the better search layer: cheaper per call at every mode, faster at the top of the range, with an independent index and an official Cloudflare AI Gateway route. It is *not* an automatic replacement for Tavily as "the recommended" layer because the deciding filter in the prior report was ToS storage posture, and Parallel's terms are more restrictive than Tavily's on exactly the points the provenance design depends on (caching output, reusing outputs, training). The honest recommendation is: add Parallel as a first-class search provider in the chain, defaulting to it for quality and cost where the operator has read §4 and accepted it; keep Tavily (or Brave in URL-only mode) as the conservative fallback; and keep the evidence layer provider-independent as already designed.

### 6.2 Against the deep-research products in `competitor-landscape.md` §4

| System | Corpus | Citations | Provenance beyond URL | Self-host/BYOK | Independent verifiability |
|---|---|---|---|---|---|
| OpenAI deep research | web + uploads | yes (sentences/passages) | none documented | No | URL-only |
| Claude Research | web + Workspace | yes | none | No | URL-only |
| Perplexity Sonar DR | web | yes | none | No | URL-only |
| Gemini Deep Research | web + Gmail/Drive/Chat | claimed | none | No | URL-only |
| STORM / GPT Researcher | web + user docs | yes | none (self-hosted, so the operator holds the fetched copy if it keeps one) | Yes | Depends on the operator's store |
| **Parallel Task API** | web, plus private input variables and MCP-attached private sources | yes (`url` + `excerpts` + `reasoning` + `confidence`) | none — URL/excerpt only | No (API only; ZDR is enterprise) | URL+excerpt-only; the excerpt is not checkable against a capture |

Parallel slots in as the strongest *API-shaped* deep-research product: it is the only one in the comparison set that returns per-field confidence and per-element citations on JSON output, exposes processors as a price/quality dial, and can be driven from a Worker. Compared with the OSS options (STORM, GPT Researcher) it gives up self-hosting and the ability to hold the fetched copy; compared with Surveyor's own C-layer it is a synthesiser, not an evidence store. Its citations are leads that still have to pass the snapshot gate.

### 6.3 Could Parallel serve both layers for engine v1?

- **As the search layer: yes, with the §4 caveats.** One key, JSON over `fetch`, 600/min, AU location code, domain/path scoping, modes from 200 ms. It is a credible primary or secondary search provider in the existing chain shape (`web-research-integration.md` §5, "Suggested chain shape").
- **As the deep-research layer: conditionally, as a delegated synthesiser.** The Task API can produce the cited research draft the engine would otherwise have to orchestrate itself, and its `basis` gives per-field evidence trails the engine can display. But its output cannot be the evidence copy, its 15,000-character input cap rules out corpus grounding, and its terms complicate caching and republishing. The clean pattern is: Task API for *research planning and synthesis* → every web URL in the basis is re-fetched and snapshotted operator-side → the engine's existing citation gate (`src/lib/serve.ts:106-118`) validates any published claim against the snapshot, never against Parallel's excerpt.
- **A middle option:** the Responses API as a research subagent (5–60 s, OpenAI wire format, `url_citation` annotations) for interactive follow-ups, with the same "leads not evidence" rule (`https://docs.parallel.ai/responses-api/examples/research-subagent`).

---

## 7. Cloudflare-specific integration notes

1. **AI Gateway has a native Parallel provider.** Endpoint `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/parallel`, with "any Parallel endpoint through AI Gateway by appending the path after `parallel`" (example given: `/v1/tasks/runs`). Auth is the Parallel key in the provider's own header (`x-api-key`), and the docs show Tasks, Search, FindAll and Chat examples (`https://developers.cloudflare.com/ai-gateway/usage/providers/parallel/`). The provider page is dated 20 April 2026 and its Search example uses the legacy `/v1beta/search` path and `processor`/`max_results` body fields; since routing is path-passthrough, the current `/v1/search` request shape should work, but that combination is not itself documented **[partially verified]** — test it before relying on it.
2. **Parallel is listed under AI Gateway's Web Search page as a "search-first provider".** "AI Gateway does not provide a provider-agnostic web search abstraction. Call the provider proxy directly using the patterns below", with a Parallel example using `/v1beta/search` and `x-api-key`. The same page says AI Gateway "applies its standard features — logging, caching, rate limiting, and guardrails — to the request" (`https://developers.cloudflare.com/ai-gateway/usage/web-search/`). Note that a cached Search response at the gateway is still the operator's own cache, but it is a place where provider output persists; the operator should decide consciously whether gateway caching is on for this route.
3. **Workers is a first-class runtime for the SDK.** The official TypeScript SDK's README enumerates "Cloudflare Workers" among supported runtimes and has zero runtime dependencies, expecting a global `fetch`; it retries 429/5xx twice by default and defaults to a 1-minute request timeout, configurable (`https://github.com/parallel-web/parallel-sdk-typescript`).
4. **Webhook verification ships a Workers example.** Parallel's webhook setup page includes a Cloudflare Workers snippet using `crypto.subtle` HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw_body}` with the `whsec_` prefix stripped and Base64-decoded (`https://docs.parallel.ai/resources/webhook-setup`). This fits a Worker route receiving Task/FindAll/Monitor callbacks; retries continue for 48 hours, so the handler must be idempotent on `webhook-id`.
5. **OpenAI compatibility without an SDK.** The Responses API is OpenAI Responses wire format on `/v1/responses` (`https://docs.parallel.ai/responses-api/openai-compatibility`); it can be called from a Worker with plain `fetch`, which sidesteps the `ai@6`-peer tool package entirely.
6. **MCP from Workers is possible but undocumented by Parallel.** Both MCP servers use Streamable HTTP (`https://search.parallel.ai/mcp`, `https://task-mcp.parallel.ai/mcp`) (`https://docs.parallel.ai/integrations/mcp/search-mcp`). Cloudflare's Agents/`workers-mcp` ecosystem can act as an MCP client, but no Parallel doc names a Cloudflare MCP client and no Cloudflare doc names Parallel's MCP servers **[unverified]**; treat MCP-on-Workers as an experiment, not a designed path.
7. **Vercel AI SDK, not Cloudflare.** Parallel's official `ai`-SDK tool package (`@parallel-web/ai-sdk-tools@1.0.0`) peer-depends on `ai@^6.0.0` (`https://registry.npmjs.org/@parallel-web/ai-sdk-tools`); Surveyor is on `ai@7` per the project brief, so the drop-in tools are not install-compatible today. The raw SDK or direct HTTP is the reliable route.
8. **The Vercel AI Gateway `parallelSearch` tool** (`https://docs.parallel.ai/integrations/vercel`) is a Vercel product, not a Cloudflare one, and is irrelevant to a Worker-hosted engine beyond comparison.

---

## 8. The three most important risks or unknowns for BYOK-on-Workers

1. **The Customer Terms can be read to permit training on, and restrict reuse of, exactly the data the engine cares about.** §4(b) grants Parallel a perpetual licence over Customer IP and explicitly allows training on it, contradicting the FAQ's "never" (§4.2). §2(b) and §2(c)(vi)/(xii) bound how output may be cached, reused and shared, and public republication of Parallel-derived content is a grey area. For an investigative tool whose submissions are sensitive by construction, this needs a legal read before any production dependency, and the mitigation is architectural: pass the minimum input needed, keep Parallel output as leads, and keep the operator's snapshot as the evidence copy. If the operator requires contractual certainty, the alternatives are Tavily (query-data opt-out, no storage prohibition found) or enterprise ZDR with a DPA — noting ZDR disables interactions and is enterprise-only in the self-serve API context (`https://docs.parallel.ai/getting-started/glossary`, `https://parallel.ai/pricing`).
2. **No evidence-grade provenance and no published default retention.** Parallel returns URLs and excerpts, never snapshots, hashes or fetch timestamps (§5.2), and the default retention window for Task/FindAll/Monitor results is undocumented (Task Group docs only say runs are "subject to your account's data-retention configuration"). The engine's citation gate therefore cannot trust a Parallel citation; every web claim must be re-fetched and snapshotted operator-side, which means Parallel reduces research effort but does not remove the Cloudflare fetch/snapshot pipeline. The `full_content` extract is the closest thing to a capture and is provider text at unrecorded fetch time.
3. **Long-running research on Workers is an orchestration problem, not a fetch problem.** Task Runs are 10 s–2 hr; Parallel's own guidance is not to block for `ultra`/`ultra8x` and to use webhooks (`https://docs.parallel.ai/getting-started/overview`, Task setup prompt; `https://docs.parallel.ai/task-api/examples/task-deep-research`). Workers have no HTTP duration limit but do have CPU limits (10 ms Free; 30 s default Paid, up to 5 min) and six simultaneous outbound connections per request (`https://developers.cloudflare.com/workers/platform/limits/`), so the pattern must be create → Queue/Workflow → webhook or scheduled poll, with HMAC-verified idempotent handlers. Supporting unknowns: no DPA or subprocessor list is published; EU residency is Search-only per the privacy policy; the AI Gateway route is a pass-through whose v1-path support is not itself documented; and the free tier requires a card, so "free to trial" and "free forever" are not the same thing.

---

## 9. What could not be verified

- Default data-retention period for Task/FindAll/Monitor outputs for non-ZDR accounts **[unverified]**; the only statement found is that runs are "subject to your account's data-retention configuration" (`https://docs.parallel.ai/task-api/group-api`).
- The Data Processing Addendum text and Parallel's subprocessor list: referenced by §4(d) and the privacy policy but not published at a discoverable URL; `/dpa` returns 404 **[unverified]** — request from `support@parallel.ai`.
- Trust Center contents (SOC 2 report scope, pen-test summaries): `https://trust.parallel.ai/` is a client-rendered Vanta page; only the FAQ claim ("SOC-II Type 1 and Type II certified as of April 2025") could be read **[unverified]** beyond that.
- EU data residency beyond the Search API, and whether Task/Responses processing can be pinned to the EU **[unverified]**.
- Responses API rate limit: documented as 300/min on the marketing pricing page but absent from the docs rate-limit table and FAQs **[partially verified]**.
- Whether Cloudflare AI Gateway's Parallel route forwards the current `/v1/search`, `/v1/extract`, `/v1/tasks/runs` (non-beta) paths — the provider page says any path can be appended but only shows legacy `/v1beta` Search and `/v1beta/findall` examples **[partially verified]**.
- Company founding date, founder, and funding claims: not stated on any corporate page fetched (the `/about` page is a manifesto). Press claims exist in third-party sources but are out of scope under the primary-sources rule **[unverified]**.
- Parallel's marketing benchmarks ("#1 on the Artificial Analysis Search Index", BrowseComp/DeepSearchQA/SEALQA results) are vendor self-reports linked from the changelog (`https://docs.parallel.ai/resources/changelog`); they are primary only as Parallel's own claims and were not independently checked **[vendor claim]**.

---

## 10. Source ledger

Parallel documentation (all `https://docs.parallel.ai/...` unless noted):

- Docs index and full-docs bundle — https://docs.parallel.ai/llms.txt, https://docs.parallel.ai/llms-full.txt
- OpenAPI spec — https://docs.parallel.ai/public-openapi.json
- Overview / API chooser — https://docs.parallel.ai/getting-started/overview, https://docs.parallel.ai/getting-started/choose-an-api
- Pricing (docs) — https://docs.parallel.ai/getting-started/pricing
- Rate limits — https://docs.parallel.ai/getting-started/rate-limits
- Glossary (ZDR, processors, modes, Basis) — https://docs.parallel.ai/getting-started/glossary
- Search: quickstart — https://docs.parallel.ai/search/search-quickstart; modes — https://docs.parallel.ai/search/modes; advanced settings — https://docs.parallel.ai/search/advanced-search-settings; migrate from Tavily/Exa — https://docs.parallel.ai/search/migrate-to-parallel
- Source policy — https://docs.parallel.ai/resources/source-policy
- Extract: quickstart — https://docs.parallel.ai/extract/extract-quickstart; advanced settings — https://docs.parallel.ai/extract/advanced-extract-settings
- Task API: quickstart — https://docs.parallel.ai/task-api/task-quickstart; deep research — https://docs.parallel.ai/task-api/examples/task-deep-research; processors — https://docs.parallel.ai/task-api/guides/choose-a-processor; run lifecycle — https://docs.parallel.ai/task-api/guides/execute-task-run; research basis — https://docs.parallel.ai/task-api/guides/access-research-basis; interactions — https://docs.parallel.ai/task-api/guides/interactions; caching best practices — https://docs.parallel.ai/task-api/best-practices; SSE — https://docs.parallel.ai/task-api/task-sse; webhooks — https://docs.parallel.ai/task-api/webhooks; group API — https://docs.parallel.ai/task-api/group-api; MCP tool calling — https://docs.parallel.ai/task-api/mcp-tool-call
- Responses API: quickstart — https://docs.parallel.ai/responses-api/responses-quickstart; citations — https://docs.parallel.ai/responses-api/features/citations; OpenAI compatibility — https://docs.parallel.ai/responses-api/openai-compatibility; research subagent — https://docs.parallel.ai/responses-api/examples/research-subagent
- FindAll: quickstart — https://docs.parallel.ai/findall-api/findall-quickstart; entity search — https://docs.parallel.ai/findall-api/entity-search; candidates — https://docs.parallel.ai/findall-api/core-concepts/findall-candidates
- Monitor: quickstart — https://docs.parallel.ai/monitor-api/monitor-quickstart; snapshot — https://docs.parallel.ai/monitor-api/quickstart-snapshot; follow-up tasks — https://docs.parallel.ai/monitor-api/monitor-task
- Memory — https://docs.parallel.ai/resources/memory
- Webhook setup (incl. Workers example) — https://docs.parallel.ai/resources/webhook-setup
- Account API (device OAuth) — https://docs.parallel.ai/integrations/account-api
- MCP: Search MCP — https://docs.parallel.ai/integrations/mcp/search-mcp; Task MCP — https://docs.parallel.ai/integrations/mcp/task-mcp
- Browser Use (private web data) — https://docs.parallel.ai/integrations/browseruse
- Vercel — https://docs.parallel.ai/integrations/vercel
- Crawler (ShapBot) — https://docs.parallel.ai/resources/crawler
- FAQs — https://docs.parallel.ai/resources/faqs
- Changelog — https://docs.parallel.ai/resources/changelog

Parallel corporate and legal:

- Homepage — https://parallel.ai/
- Pricing (marketing) — https://parallel.ai/pricing
- Free-tier blog — https://parallel.ai/blog/free-tier-parallel
- Company essay — https://parallel.ai/about
- Customer Terms and Conditions — https://www.parallel.ai/customer-terms
- Website Terms of Use — https://parallel.ai/terms-of-service
- Acceptable Use Policy — https://www.parallel.ai/acceptable-use-policy
- Privacy Policy — https://www.parallel.ai/privacy-policy
- Trust Center — https://trust.parallel.ai/
- Status page (API v2) — https://status.parallel.ai/
- Platform (keys, billing) — https://platform.parallel.ai

SDKs and code:

- GitHub org — https://github.com/parallel-web
- TypeScript SDK — https://github.com/parallel-web/parallel-sdk-typescript (npm: https://www.npmjs.com/package/parallel-web)
- Python SDK — https://github.com/parallel-web/parallel-sdk-python (PyPI: https://pypi.org/project/parallel-web/)
- Vercel AI SDK tools — https://www.npmjs.com/package/@parallel-web/ai-sdk-tools

Cloudflare:

- AI Gateway Parallel provider — https://developers.cloudflare.com/ai-gateway/usage/providers/parallel/
- AI Gateway Web Search (search-first providers) — https://developers.cloudflare.com/ai-gateway/usage/web-search/
- Workers platform limits — https://developers.cloudflare.com/workers/platform/limits/

Repo context:

- `docs/research/web-research-integration.md` (Tavily/Brave/Exa comparison, provenance design, shortlist) and `docs/research/competitor-landscape.md` §4.
