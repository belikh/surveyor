# Architecture Decision Records

Decisions that shape the investigation platform (the `surveyor/` installation).
The platform follows this repository's stated principles — source protection
first, secrets never in transcripts, untrusted data treated as data,
library-first, test-verified security, minimal identity surface, bounded
agency, honest threat modelling, corpus purity, Australian English
(`README.md` §Principles, `CONTRIBUTING.md`).

| ADR | Decision | Source |
|---|---|---|
| [0001](0001-tenant-isolation-and-byok.md) | One investigation per installation; BYOK provider registry; degraded keyless mode | wayfinder `t01-tenant-byok` |
| [0002](0002-corpus-ingestion-and-ocr.md) | Async ingestion lanes, vision OCR, multi-modal rescue, pre-mirror name-leak gate | wayfinder `t03-corpus-ocr` |
| [0003](0003-digest-angles-and-research-engine.md) | LLM-proposed grounded angles, capped research lines, ledger-backed retrigger, flag-and-gate | wayfinder `t04-digest-research` |
| [0004](0004-report-outputs-and-publish-gates.md) | Five report types, manual-first gates, four frequencies, append-only history (two-tier rewrites retired 2026-09-17) | wayfinder `t05-report-gates` |
| [0005](0005-installer-and-uninstaller.md) | Two-phase install (deploy button + scoped-token fallback), wizard is code, honest teardown receipt | wayfinder `t02-installer` |
| [0006](0006-launch-pack.md) | Seven-asset launch pack, URL-only QR, regenerable, zero operator identity | wayfinder `t06-launch-pack` |
| [0007](0007-ai-sdk-registry.md) | Provider registry implemented on the Vercel AI SDK (`ai@7` + `@ai-sdk/openai-compatible@3`) | remediation R2 |
| [0008](0008-byok-key-entry.md) | BYOK key entry through wizard OAuth consent; transient token; slot name only | remediation R2 |
| [0009](0009-runtime-provisioner.md) | Runtime provisioner + teardown via OAuth consent; persisted receipt; Worker deleted last | remediation R3 |
| [0010](0010-journalist-pass.md) | Journalist pass: one Workflow step per report type; cite-bound; annotate uncited, strip on publish | remediation R7 |
| [0011](0011-ingestion-browser-rasterisation.md) | Native parse + toMarkdown fallback + vision OCR; browser PDF.js rasterisation; capability tags | remediation R6 |
| [0012](0012-submitter-file-uploads.md) | Submitter file uploads; controlled Principle I exception; private transcript R2, deleted after OCR | operator decision |
| [0013](0013-oauth-pkce.md) | OAuth client switches to PKCE (amends 0008); no embedded secret | remediation R2 follow-up |
| [0014](0014-licence-and-repository-split.md) | AGPL-3.0; new public repo with squashed history; publication is a human step | remediation R8 |
| [0015](0015-automation-stance.md) | Autonomous upstream, human publish: angles auto-approve unless flagged, lines complete within caps, publication is always an operator act | campaign #1 |
| [0016](0016-anonymity-deviation.md) | Anonymity deviation: TLS in transit and sealing at rest; no Tor, no source-side end-to-end encryption | campaign #1 |
| [0017](0017-web-research-and-snapshot-provenance.md) | Web research: the immutable R2 snapshot is the evidence, never the live URL | campaign #1; B7 (#25) |
| [0018](0018-providers-are-leads-not-evidence.md) | Capability-tagged providers; their output is leads to re-fetch, never evidence | campaign #1; B4 (#22), B6 (#24) |
| [0019](0019-compliance-posture.md) | Operator is the data controller; controls, instrument templates and receipts; no certification claims | campaign #1; D-series |

**Provenance note.** The `wayfinder` tickets and `remediation` IDs named in the
early ADRs (`t01-…`, `R2 (#26)`, and so on) are from the pre-split planning
repository. They are historical identifiers, not paths and not issue numbers in
this repository. The research reports underpinning the campaign ADRs live in
`docs/research/`: the architecture audit, the competitor landscape, web-research
integration, the Parallel API review, the Australian legal compliance report,
and the audio transcription options.

## Known deviations from these decisions

The campaign build (#1) merged to `main` on 2026-09-17. This list records where
the code still falls short of a decision, with the owning ticket.

- **0002 / 0011** — the wizard does not yet ask for capability tags (B5, #23);
  the two-page multi-modal rescue is not built (superseded by ADR-0011).
  Digital lanes parse natively (C1 #32, C2 #33) with the model pass as the
  fallback, the browser rasterisation path ships with the served PDF.js worker
  asset (A5, #6), and the dependency-free parser choice is recorded in 0002's
  amendment.
- **0003** — research lines exist with citation validation and spend caps but do
  not research autonomously; a line completes through the operator's findings
  POST. The corpus tool loop is B1 (#19), spend enforcement B2 (#20), finding
  completion B3 (#21). Angles default to the deterministic proposer; LLM
  proposal is opt-in `mode: "live"`. A corpus upload does not retrigger
  (unclaimed).
- **0004 / 0010** — the journalist pass runs inline in the publish path, has no
  per-pass cap, and falls back to the deterministic render rather than Workers
  AI (B12, #30). The automatic-publish branch still renders due reports when
  stored gates are met; ADR-0015 retires it and records gates as advisory, and
  that code change is not yet claimed by a ticket.
- **0005 / 0009** — provision and teardown have routes and receipts but have not
  been exercised against a live Cloudflare account (A16, #17; A17, #18), and
  re-provisioning is not yet non-destructive (A2, #3). The reseal path still
  names the pre-campaign sealed-column set, so A2 must extend it alongside the
  audit's list.
- **0015** — angles still queue for explicit approval rather than
  auto-approving unless flagged (B-series engine build, #19–#21), and it is the
  scheduled digest that still auto-publishes where gates are met (see 0004).
- **0017 / 0018** — the snapshot store and web-citation validation are B7
  (#25); fetched-text delimiters and injection flagging are B8 (#26); the
  Tavily/Parallel search layer is B6 (#24). B10's provider-terms review is
  drafted in `docs/research/provider-terms-review.md` and awaits human legal
  sign-off (#27, `ready-for-human`).
- **0019** — the retention and deletion engine is D1 (#44) and D2 (#45);
  residency receipts are D6 (#49); the quality-evidence artefacts that gate the
  public claim are D8 (#51), D9 (#52) and D11 (#54).
- **0012** — resolved: the raw-byte deletion window is enforced by the
  scheduled sweep (A3, #4), both upload paths stream without buffering the body
  (A14 #15, A15 #16), and the ciphertext audit covers every sealed column in the
  schema (A13, #14).
- **0019** — implemented in the campaign and no longer deviating: breach
  assessment and NDB workflow (D3, #46), privacy and collection notices (D4,
  #47), sensitive-category consent (D5, #48), the publication legal gate (D7,
  #50) and the published Niro report evidence (D10, #53).
