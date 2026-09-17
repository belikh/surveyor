# ADR-0004: Five report types behind manual-first gates and two-tier rewrites

**Status**: Accepted (wayfinder decision, 2026-09-14); two-tier rewrite routing
retired 2026-09-17 (#31)

**Deciders**: operator (user), via wayfinder ticket `t05-report-gates`

## Context

The spec's marquee output is a *living* report — but an investigation that
auto-publishes on adversarial input is dangerous, and one that only updates on
demand is not live. The configuration surface must expose output types, publish
gates, update frequency, and rewrite depth without letting an operator
accidentally publish poisoned material.

Primary source: the pre-split wayfinder ticket `t05-report-gates` (operator
decisions, 2026-09-14; not carried into this repository).

## Decision

**Five independently enableable output types**: live briefing, investigative
long-form, evidence dossier (claim → exhibits), timeline, data snapshot.

**Manual approval gates publication by default.** Automatic gates (submission
count, elapsed time, evidence thresholds) are **opt-in and combinable**; a
report publishes on manual approval **or** when all enabled automatic gates are
satisfied. (Amended by ADR-0015: publication is always an operator act; stored
gates become advisory checks recorded with the publish action.) Gate
configuration is stored with the report — never accepted in the publish call
itself — so a publish can never self-authorise.

**Four update frequencies per report**: manual push, scheduled digest
(**default**), per-N-submissions, and full-dynamic-after-every-submission. The
last is **marked dangerous** and carries a review banner, because it re-renders
on any new evidence and thus widens the poisoning exposure window.

**Rewrite depth is two-tier, routed by the significance judge** (ADR-0003).
Corroboration-only submissions tick lightweight updates (evidence counts,
dossier tallies); substantial new material (new angles, claims, unresearched
ground) triggers a full journalist pass. _(Retired 2026-09-17 — see Update.)_

**Published history is append-only.** Regeneration produces a new version; a
published reader's words never change silently.

## Update (2026-09-17): two-tier rewrite routing retired (#31)

The two-tier rewrite routing is **retired**, not wired. Nothing at the report
layer ever derived new topics from the significance judge (ADR-0003): the
judge's output feeds research-line retriggering (`src/lib/retrigger.ts`), while
the stored `pending_topics` queue never influenced a publish. The dormant
`POST /:type/tick` route and the `pending_topics_json` and `corroborations`
columns are removed so no route advertises a routing decision it cannot make.
Reports re-render through the one shared publish path
(`src/lib/publish.ts`), whose counts are read from the evidence at render
time. Append-only versioning, gate evaluation and the four frequencies are
unchanged.

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
- A model-written "journalist pass" was the spec's ambition and was not
  delivered at this ADR's date; ADR-0010 delivered it. The pass still runs
  inline without a per-pass cap and falls back to the deterministic render
  rather than Workers AI (B12, #30).

## References

- Wayfinder ticket: `t05-report-gates` (pre-split; not carried into this
  repository)
- Remediation against the current build: R7
- Superseded in part by: ADR-0010 (journalist pass), ADR-0015 (automation
  stance)
