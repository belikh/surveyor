# ADR-0018: Providers are capability-tagged, and their output is leads, not evidence

**Status**: Accepted (2026-09-17, campaign grilling)

**Deciders**: operator (user), campaign #1; Parallel API and web-research
reports

## Context

The BYOK registry (ADR-0001, ADR-0007) grows past two chat slots: Tavily and
Parallel are first-class search/extract providers, and Parallel's Task API can
delegate web-heavy research. Provider output is text at an unrecorded fetch
time, and provider terms complicate caching and republishing (Parallel's
training and output-caching clauses; Tavily's query-data settings). The
integration research concluded that provider results cannot be the evidence
copy.

## Decision

- **Each registry entry carries a capability tag** (`chat`, `vision`, `search`,
  `extract`, `audio`), an operator-visible order and a secret slot; the wizard
  asks for capabilities, so tags are reachable without a hand-written API call.
- **Tavily and Parallel are first-class** search and extract options;
  Parallel's Task API is an optional delegation for web-heavy lines.
- **Provider output is leads, never evidence.** Snippets, extracted text and
  deep-research drafts may guide a line, but every fact to be cited is
  re-fetched and snapshotted installation-side and validated against the
  snapshot (ADR-0017).
- **Delegation sits behind one interface**, so providers can be added or
  removed without touching the engine core.
- **No provider becomes a default dependency before its terms are reviewed and
  recorded** — Parallel's training and output-caching clauses first (B10, #27).

## Consequences

**Positive**

- Provider terms cannot silently become the platform's retention or
  republishing posture: no provider text sits in the evidence chain.
- Capability tags stop a lane routing work to a provider that cannot do it.
- Swapping or adding providers is a registry edit, not an engine change.

**Negative / trade-offs**

- Every provider-sourced claim needs a second hop (re-fetch plus snapshot), so
  delegation saves planning effort, not fetch cost or latency.
- Provider outages and term changes can remove capability at short notice; the
  engine falls back deterministically rather than failing.
- The registry gains configuration surface (tags, order, slots) that the
  operator must understand; a mistagged entry is a mis-routed call.

## References

- Campaign: #1 (providers; user stories 25–30)
- Research: `docs/research/parallel-ai-api.md` §4–§5;
  `docs/research/web-research-integration.md` §2
- Related: ADR-0017 (snapshot evidence), ADR-0007 (AI SDK registry)
