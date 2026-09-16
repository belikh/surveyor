# ADR-0004: Five report types behind manual-first gates and two-tier rewrites

**Status**: Accepted (wayfinder decision, 2026-09-14)

**Deciders**: operator (user), via wayfinder ticket `t05-report-gates`

## Context

The spec's marquee output is a *living* report — but an investigation that
auto-publishes on adversarial input is dangerous, and one that only updates on
demand is not live. The configuration surface must expose output types, publish
gates, update frequency, and rewrite depth without letting an operator
accidentally publish poisoned material.

Primary sources: `.scratch/cloudflare-native/issues/t05-report-gates.md`
(operator decisions, 2026-09-14).

## Decision

**Five independently enableable output types**: live briefing, investigative
long-form, evidence dossier (claim → exhibits), timeline, data snapshot.

**Manual approval gates publication by default.** Automatic gates (submission
count, elapsed time, evidence thresholds) are **opt-in and combinable**; a
report publishes on manual approval **or** when all enabled automatic gates are
satisfied. Gate configuration is stored with the report — never accepted in the
publish call itself — so a publish can never self-authorise.

**Four update frequencies per report**: manual push, scheduled digest
(**default**), per-N-submissions, and full-dynamic-after-every-submission. The
last is **marked dangerous** and carries a review banner, because it re-renders
on any new evidence and thus widens the poisoning exposure window.

**Rewrite depth is two-tier, routed by the significance judge** (ADR-0003).
Corroboration-only submissions tick lightweight updates (evidence counts,
dossier tallies); substantial new material (new angles, claims, unresearched
ground) triggers a full journalist pass.

**Published history is append-only.** Regeneration produces a new version; a
published reader's words never change silently.

## Consequences

**Positive**

- Default-safe: doing nothing publishes nothing, and every automatic gate is an
  explicit opt-in.
- Liveness is tunable to the investigation's risk rather than fixed.
- Versioned, append-only history preserves reader trust and gives the operator
  an audit trail.

**Negative / trade-offs**

- Full-dynamic mode is a deliberate hazard: it is shipped, but marked and
  banner-wrapped. Held lines are still excluded, so the exposure is bounded by
  the poisoning gate, not eliminated.
- The two-tier split adds a routing dependency on the significance judge; a
  judge outage degrades to the corroboration tick, never to a full pass.
- A model-written "journalist pass" is the spec's ambition, not yet delivered;
  deterministic templates currently stand in for it (see R7, #30).

## References

- Wayfinder ticket: `.scratch/cloudflare-native/issues/t05-report-gates.md`
- Remediation against the current build: R7 (#30)
