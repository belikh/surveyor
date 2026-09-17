# Architecture Decision Records

Decisions that shape the investigation platform (the `surveyor/` installation).
The platform inherits this repository's constitution
(`.specify/memory/constitution.md`).

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

The raw wayfinder map and tickets live in `.scratch/cloudflare-native/`. Two
research files underpin these decisions:
`.scratch/cloudflare-native/research/installer-mechanism.md` and
`.scratch/cloudflare-native/research/corpus-ocr-pipeline.md`.

## Known deviations from these decisions

Fresh-eyes review (2026-09-16) found the implementation does not yet deliver
several decisions. The remediation issues track them:

- **0001** — no runtime code path accepts a provider key (R2 #26) — **resolved**
  by ADR-0008; AI SDK registry implemented by ADR-0007.
- **0002** — OCR lane pastes base64 into a text prompt; no vision, no `env.AI`
  (R6 #29).
- **0003** — submission rounds are static; retrigger is manual, the judge never
  auto-invokes (R4 #28).
- **0004** — the "journalist pass" does not exist; reports are deterministic
  templates (R7 #30).
- **0005** — provision/teardown are test-only, with no runtime caller (R3 #27)
  — **resolved** by ADR-0009.
