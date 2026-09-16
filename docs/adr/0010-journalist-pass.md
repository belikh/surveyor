# ADR-0010: Journalist pass — one LLM pass per report type

**Status**: Accepted (2026-09-16, user decisions under grilling)

**Deciders**: operator (user), remediation R7 (#30)

## Context

The spec's marquee output is a living report, but the build renders
deterministic templates and the "journalist pass" was a JSON action string.
R7 offered Option A (implement the pass) or Option B (rescope to evidence
digests). The operator chose to implement it.

## Decision

- **All five report types** get model-written prose.
- **One pass per report type**, each a resumable **Workflow step** through the
  provider registry (BYOK) with Workers AI fallback and a **per-pass spend
  cap**; no combined pass, so enablement, gating, and versioning stay per type.
- Prose is **fenced, versioned, and cite-bound**: every claim carries a mirror
  exhibit. **Uncited claims are annotated in drafts and stripped on publish
  unless the operator explicitly approves them.**
- **Timeline**: the pass proposes dated entries (date + short label + short
  paragraph + citations) from gated findings. Entries are stored as
  **structured records**, operator-editable, and rendered deterministically.
- **Snapshot**: deterministic statistics plus a model-written **lead
  paragraph** — the numbers stay auditable.
- Held lines are excluded from every pass.

## Consequences

**Positive**

- The product's claim becomes true, and the operator keeps editorial control
  (annotate → approve → publish).
- Structured timeline entries are editable and diffable rather than opaque
  prose blobs.
- Per-type passes keep one failure from blocking all reports.

**Negative / trade-offs**

- Five passes multiply provider cost; the per-pass cap and per-turn telemetry
  are the guardrails.
- The annotate-then-strip rule means a draft can read differently from the
  published version; the version history records both.
- Pass quality is bounded by the gated findings; a thin corpus yields thin
  prose.

## References

- Remediation: R7 (#30); spec FR-036
- Related: ADR-0004 (report surface), ADR-0003 (engine/grounding)
