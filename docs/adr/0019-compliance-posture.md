# ADR-0019: Compliance posture — operator as data controller; controls, notices and receipts, no certification

**Status**: Accepted (2026-09-17, campaign grilling)

**Deciders**: operator (user), campaign #1; Australian legal compliance report

## Context

Australian legal research maps what a workplace investigation implies under the
Privacy Act (APP 1, 5, 8, 11 and the ADM disclosure), the Notifiable Data
Breaches scheme, workplace surveillance and recording laws, and defamation with
its right-of-reply defences. Two facts bound the software: the operator
installs Surveyor in their own account and is the data controller for what it
holds; and Cloudflare offers **no Australian storage jurisdiction** for R2
(eu/fedramp/us) or D1 (eu/fedramp), so residency pinning is impossible.

## Decision

- **The operator is the data controller.** Surveyor ships controls, instrument
  templates and receipts; it makes **no certification claims** (no SOC 2, no
  ISO 27001/37002 or equivalent).
- **Residency is documented, not claimed.** Installations may store data
  outside Australia; data-flow and residency receipts name Cloudflare and each
  BYOK provider as recipients.
- **Retention is an engine**: per-category windows with configurable safe
  defaults, scheduled sweeps, and verified deletion receipts.
- **Breach assessment** carries the 30-day notification clock and OAIC
  statement drafting; **privacy and collection notices** are generated as
  instrument text, including the automated-decision disclosure.
- **Sensitive-category consent** is captured at intake, and **publication is
  gated** for legal review and right of reply.
- **The legal research report is research, not legal advice**; the obligations
  it lists remain with the operator.
- **Quality claims rest on evidence**: OCR accuracy, report quality,
  penetration tests and live trials are published before any "better than the
  best" wording appears.

## Consequences

**Positive**

- An operator gets controls for duties they already carry, without a vendor
  sitting between them and their sources.
- Honest boundaries (residency, no Tor or source-side encryption, no
  certification) are stated where they cannot be satisfied.
- Receipts make deletion and cross-border disclosure provable rather than
  promised.

**Negative / trade-offs**

- Operators must act: the software generates notices and workflows, not
  compliance, and uninformed use can still breach APP duties.
- No certification creates procurement friction with organisations that
  require one; the answer is evidence (tests, receipts, published audits), not
  a badge.
- Configurable retention means a careless configuration can delete evidence
  too early or hold it too long; safe defaults and receipts bound the damage
  but not the choice.

## References

- Campaign: #1 (compliance posture; user stories 47–58)
- Research: `docs/research/australian-legal-compliance.md`
- Related: ADR-0016 (anonymity deviation), ADR-0014 (public repo)
