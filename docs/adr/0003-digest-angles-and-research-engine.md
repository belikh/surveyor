# ADR-0003: LLM-proposed angles, capped research lines, ledger-backed retrigger

**Status**: Accepted (wayfinder decision, 2026-09-14)

**Deciders**: operator (user), via wayfinder ticket `t04-digest-research`

## Context

The engine must digest the corpus, find investigative angles, and run research
extensively — autonomously, on Cloudflare, with no CLI and no reuse of the
Python pipeline's runtime code paths. It must also be re-runnable: new evidence
should retrigger from an intermediate stage without duplicating work or rebilling.
Two of its components (an angle proposer and a significance judge) are
themselves LLM calls, which sit inside the trust boundary they help enforce.

Primary sources: `.scratch/cloudflare-native/issues/t04-digest-research.md`
(operator decisions Q-sheet, 2026-09-14).

## Decision

**Angles are LLM-proposed end-to-end over the gated corpus** — there is no
separate deterministic digest stage. Every angle must carry **cited corpus
exhibits**, and no exhibit-free angle is stored. Proposed angles land in an
**operator-visible queue**; research spend only happens after the operator
approves an angle.

**One Cloudflare Workflow per research line**, with a per-line **spend cap** and
a **citation requirement**: a line cannot complete without citations, and every
cited document must exist in the mirror.

**Retrigger is judged, then ledgered.** An LLM significance judge decides whether
new material (a completed submission, an addendum, a corpus upload) introduces
genuinely new concepts or facts worth researching. The judge's input is bounded
(cheap, not a full-corpus re-read), and the **topics ledger is the idempotency
backstop**: the judge may only **narrow** the deterministic candidate set, never
widen it, so settled ground never re-runs or rebills.

**Poisoning posture is flag-and-gate.** Suspicious lines are held from every
report type pending operator review; provenance is always marked; nothing
poisoned auto-publishes. Because the judge and proposer are themselves
LLM-exposed, their outputs stay inside the untrusted fence and never publish
directly.

## Consequences

**Positive**

- The operator's editorial judgement gates spend: queued angles are visible
  before any research line opens.
- Idempotency is structural (set intersection against a ledger), not a prompt
  promise.
- Grounding is enforced by validation: an angle whose exhibits do not occur in
  the cited document is dropped, counted, and never stored.

**Negative / trade-offs**

- Angle quality is bounded by corpus quality and by the breadth of the bounded
  judge input; a thin corpus yields thin angles.
- The engine's two LLM surfaces are an injection target, so their output
  policing must be maintained as part of the security surface (constitution
  III).
- Full-corpus re-reads per trigger were **rejected** on cost grounds; the
  trade-off is a judge that may miss significance that only emerges across the
  whole corpus.

## References

- Wayfinder ticket: `.scratch/cloudflare-native/issues/t04-digest-research.md`
- Remediation against the current build: R4 (#28)
