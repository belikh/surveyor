# ADR-0015: Automation stance — autonomous upstream, publication is a human act

**Status**: Accepted (2026-09-17, campaign grilling)

**Deciders**: operator (user), campaign #1

## Context

ADR-0004 shipped manual-first gates with opt-in automatic gates: a report
published when all enabled gates were satisfied, with no human in the loop.
The campaign reverses that for publication while widening autonomy everywhere
upstream. An investigation built on adversarial input must not publish on a
timer: the poisoning, defamation and privacy exposure of an automatic publish
is borne by the operator, and the competitor survey found the strongest
systems keep a human publish step.

## Decision

- **Angles auto-approve unless flagged.** Flagged angles, lines, findings and
  drafts are held for operator review and excluded from every report.
- **Research lines open and complete autonomously within per-line caps**
  (steps, tokens, spend, wall time), and halt rather than burn past them.
- **Drafts are produced automatically.** The journalist pass runs per report
  type; every claim stays cite-bound, and uncited claims are annotated in the
  draft and stripped on publish unless the operator approves them.
- **Publication is always an explicit operator action.** ADR-0004's
  automatic-publish branch is retired: stored gates become advisory checks
  recorded with the publish action, never self-authorising.
- Every automated stage's output is marked untrusted; flags hold, they never
  publish.

## Consequences

**Positive**

- Human judgement stays where the liability is (publication) while automation
  removes the drudgery (proposal, research, drafting).
- A compromised or manipulated engine can at worst produce held output, not a
  live report.
- Caps make autonomous spend bounded and auditable per line.

**Negative / trade-offs**

- Publication throughput is capped by the operator's queue: an absent operator
  means no new versions, so "living report" liveness is deliberately less than
  a fully automatic system.
- Auto-approved angles can spend against weak lines before review; caps and
  flag holds bound that risk but do not remove it.
- Retiring the automatic gates moves work to the operator (a scheduled digest
  proposes a ready draft; publishing it is still a click).

## References

- Campaign: #1 (automation stance; user stories 18–23)
- Amends: ADR-0004 (automatic-publish branch retired)
- Related: ADR-0003 (engine), ADR-0010 (journalist pass)
