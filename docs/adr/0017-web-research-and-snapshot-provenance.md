# ADR-0017: Web research — the immutable snapshot is the evidence, never the live URL

**Status**: Accepted (2026-09-17, campaign grilling)

**Deciders**: operator (user), campaign #1; web-research integration report

## Context

The engine extends beyond the corpus to web search and extraction over the
operator's BYOK providers. A URL is not evidence: pages drift, paywall, move
and disappear, and a provider's snippet is text the installation never
observed at a recorded time. Citations that resolve to "whatever the URL
serves today" cannot be validated at write time and cannot defend a published
claim later.

## Decision

- **Every web citation validates by exact occurrence in an immutable R2
  snapshot the installation fetched**, never against the live URL and never
  against a provider's snippet or summary.
- **The snapshot records provenance**: requested URL, final URL, fetch
  timestamp, HTTP status, content type, a SHA-256 of the extracted text and
  the extractor version.
- **Search results are transient pointers.** Titles, URLs and provider
  snippets may be shown to the operator and held briefly, but only snapshots
  enter the evidence chain.
- **Fetched text is untrusted data**: delimited and labelled as such in every
  prompt, with injection markers flagged and held exactly as corpus text is.
- **Snapshots are never republished** and follow the retention engine. Archive
  links (Wayback, SPN) are best-effort corroboration beside the snapshot,
  never the evidence.

## Consequences

**Positive**

- A published claim can be checked against the bytes the platform actually saw
  at a recorded time, so drift is visible instead of silent.
- Provider terms that restrict retaining or republishing output do not force a
  weaker standard on the platform: providers stay pointers.
- The evidence chain stays one shape — a gated copy plus a citation — whether
  the source is the corpus or the web.

**Negative / trade-offs**

- Every web citation costs a fetch, a snapshot and storage; web-heavy lines
  are slower and more expensive than URL-only research.
- Pages that cannot be fetched or snapshotted (hard paywalls, robots refusals,
  dead links) cannot support a claim, even when a provider can describe them.
- Snapshots may contain personal data the investigation never intended to
  collect; retention windows and the deletion engine apply, but an
  already-published citation outlives a deleted snapshot.

## References

- Campaign: #1 (engine architecture, web citation rule)
- Research: `docs/research/web-research-integration.md` §2
- Related: ADR-0018 (providers are leads), ADR-0002 (corpus custody)
