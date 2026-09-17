# Surveyor architecture and completeness audit

Scope: an internal audit of this repository against its own documents. Primary
sources only (the repository itself). No production code was changed; the only
file written is this report.

Grounding runs, 2026-09-17, at commit `5079e7c` (`fix(security): remediate
second Niro pentest findings`):

- `npm run typecheck` — clean, no output.
- `npm test` — 36 test files, 268 tests, all pass (`vitest 3.2.7`, ~9 s).
- `npm run build` — clean; `dist/worker.js` 2.4 MB, `dist/pdf-tools.txt` 1.02 MB,
  `dist/smoke-lib.js` 2.5 KB.

Australian English is used throughout. Statements that could not be verified
from the repository are marked **unverified**. Nothing here is a live-runtime
result: see §6.

---

## 1. Module inventory

`src/` has 29 files in `src/lib/`, 5 route modules, 4 frontend modules, plus the
worker entry, state, env types, declaration file, and schema. Every source
module is listed.

### Worker entry and state

| Module | Responsibility | Public entry points |
|---|---|---|
| `src/index.ts` | Hono app; security headers; operator auth; setup, provider key entry, OAuth callback, audit, reseal, provision and teardown routes; `EngineWorkflow`; `scheduled()`; queue consumer | `app` (default export `{ fetch, scheduled, queue }`), `EngineWorkflow`, `EngineParams` |
| `src/state.ts` | Per-isolate boot: schema migration, additive `ALTER`s, setup-state cache, audit writer; fails closed without key material | `getState`, `boot`, `InstallationUnprovisioned`, `AppState` |
| `src/env.ts` | Binding types for the Worker | `Bindings`, `IngestMessage` |
| `src/types.d.ts` | `*.sql` / `*.txt` module declarations | — (types only) |
| `src/db/schema.sql` | DDL: setup, provision, audit, telemetry, submissions, messages, entities, topics, corpus docs, FTS, launch, angles, research lines, reports, versions, receipts, entries, attachments | statement list consumed by `state.ts:57-61` |

### Domain library (`src/lib/`)

| Module | Responsibility | Public entry points |
|---|---|---|
| `vault.ts` | AES-256-GCM envelopes, HMAC code/name keys, access codes | `createVaultKit`, `createPowKey`, `sealText`, `openText`, `accessCode`, `codeHmac`, `nameHmac`, `b64urlEncode/Decode`, `toHex/fromHex`, `VaultKit` |
| `pow.ts` | Stateless HMAC proof-of-work challenge/verify/solve | `issueChallenge`, `verifyChallenge`, `solveChallenge`, `leadingZeroBits`, constants |
| `intake.ts` | Intake Zod schemas, static question pool, deterministic name quarantine | `CreateBodySchema`, `StepsBodySchema`, `quarantineText`, `canonicaliseText`, `nextQuestions`, `STATIC_QUESTIONS`, `QUESTIONS_PER_ROUND` |
| `ingest.ts` | Corpus lane classification, upload schema, pre-mirror gate | `classifyLane`, `gateCorpusText`, `statusFor`, `UploadBodySchema`, `MAX_DOC_BYTES`, `Lane` |
| `drain.ts` | Drain state machine; Workers AI `toMarkdown` and vision handlers | `drainPlan`, `applyDrain`, `runDrain`, `buildDrainHandlers`, `HeldDoc`, `AiBinding` |
| `lanes.ts` | Assembles lane providers from the registry plus `env.AI` | `buildLaneProviders`, `buildLaneHandlers` |
| `attachments.ts` | Submitter attachment lanes, quota, drain, deletion | `drainAttachmentById`, `attachmentLane`, `attachmentBytes`, `ATTACH_MAX_BYTES`, `ATTACH_TOTAL_BYTES`, `ATTACH_RETRY_MS` |
| `engine.ts` | Deterministic angle proposal/ranking, significance floor, injection flags | `proposeAngles`, `rankAngles`, `judgeSignificance`, `normaliseTopic`, `injectionFlags`, `flagSuspicious` |
| `serve.ts` | Vercel AI SDK provider chain client; live angle proposal and judge | `buildChainClient`, `proposeAnglesLive`, `judgeSignificanceLive`, `ModelClient`, `ChainEntry` |
| `angles.ts` | Propose-and-store grounded angles, ledger de-dup, flag storage | `proposeAndStoreAngles`, `ProposeResult` |
| `retrigger.ts` | Submission-completion retrigger, investigation ledger, per-event cap | `completeAndRetrigger`, `retriggerOnCompletion`, `investigationLedger`, `RETRIGGER_CAP` |
| `rounds.ts` | Corpus-grounded follow-up question rounds with static fallback | `groundedQuestions`, `searchMirror`, `ROUNDS_MAX` |
| `evidence.ts` | One evidence bundle for renders, publish, scheduler | `gatherEvidence`, `unwrap` |
| `reports.ts` | Gate config schema, gate evaluation, five deterministic renderers | `GateConfigSchema`, `evaluateGates`, `RENDERERS`, `REPORT_TYPES`, `ExhibitRefSchema`, `Evidence` |
| `publish.ts` | Shared publish path: gates, pass, atomic versioning, sealed history | `publishReportVersion`, `reportRow`, `GatesUnmet`, `ReportDisabled`, `ReportVersionSchema` (unused) |
| `pass.ts` | Journalist pass per report type; grounding, annotation/strip, timeline entries | `runJournalistPass`, `PassOutputSchema`, `PASS_DOC_BUDGET` |
| `schedule.ts` | Due checks and `evaluateAll` with receipts | `dueCheck`, `evaluateAll`, `DEFAULT_CADENCE_MS`, `FULL_DYNAMIC_BANNER` |
| `providers.ts` | Provider availability; single secret-read choke point; live client | `currentProviders`, `secretValue`, `hasSecretValue`, `liveClient` |
| `registry.ts` | Chain resolution, stored-state sanitisation, custom-provider probe, reorder | `resolveChain`, `sanitiseStoredSetup`, `validateCustomProvider`, `reorderProviders` (test-only), `ChainResolution` |
| `setup.ts` | Setup phase machine, provider/instrument schemas, provider slot allow-list | `SetupStateSchema`, `SetupStepSchema`, `validateSetupStep`, `PROVIDER_SLOTS`, `isProviderSlot` |
| `net.ts` | Provider destination policy (https, public host, no private/loopback) | `isAllowedProviderBaseUrl` |
| `scopes.ts` | Abstract provisioner scope list and revocation copy | `REQUIRED_SCOPES`, `checkScopes`, `REVOCATION_GUIDANCE` |
| `oauth.ts` | OAuth consent URL, signed state, code exchange | `authorizeUrl`, `exchangeOAuthCode`, `signState`, `verifyState`, `DEFAULT_*` |
| `secrets.ts` | Cloudflare Worker secret PUT/DELETE with slot allow-list | `putWorkerSecret`, `deleteWorkerSecret`, `SECRET_SLOT` |
| `cfapi.ts` | Cloudflare REST adapter for the runtime provisioner | `createCloudflareApi`, `CfApiContext` |
| `provision.ts` | Provision/teardown orchestration over an injected API | `provisionStack`, `teardownStack`, `ProvisionReceipt`, `TeardownReceipt`, `ProvisionError` |
| `pack.ts` | Launch pack build and structural audit; slug minting | `buildCopy`, `auditPack`, `mintSlug`, `LaunchPack` |
| `telemetry.ts` | Per-turn tier/outcome records | `recordTurn`, `listTelemetry`, `TurnRecord` |
| `smoke.ts` | Smoke helpers shared by script and tests | `auditHeaders`, `solvePow`, `auditCiphertext`, `summarise`, `formatReceipt` |

### Routes (`src/routes/`)

| Module | Responsibility | Public entry points |
|---|---|---|
| `intake.ts` | Public intake: challenge, create, steps, resume, addendum, rounds, submitter attachments and attachment drain | default Hono router; `MAX_HITS_PER_ANSWER`, `WRITE_BUDGET_ROWS` (internal) |
| `corpus.ts` | Operator corpus upload/list/drain; `drainDocById` shared with the queue | default router; `drainDocById` |
| `engine.ts` | Angles propose/list/approve/review; lines open/complete/spend/review/get; retrigger | default router |
| `reports.ts` | Report config/approve/publish/tick/read/versions/draft | default router |
| `launch.ts` | Launch pack generate/rotate | default router |

### Frontend (`src/frontend/`)

| Module | Responsibility | Public entry points |
|---|---|---|
| `chrome.ts` | Mac OS 9-styled wizard shell + driver (token, providers, instrument, teardown) | `wizardShell`, `WIZARD_JS`, `WIZARD_CSS` |
| `survey.ts` | Source-facing survey shell + driver (consent → create/resume → rounds → attachments) | `surveyShell`, `SURVEY_JS`, `SURVEY_CSS` |
| `uploader.ts` | Operator corpus uploader shell (PDF extraction/rasterisation then upload) | `uploaderShell`, `UPLOADER_JS`, `UPLOADER_CSS` |
| `pdf-tools-entry.ts` | Self-hosted PDF.js wrapper: text extraction, page rasterisation | sets `window.SurveyorPdf` (`extractText`, `rasterise`, `pageCount`) |

No source module is entirely unreferenced by the worker (all are imported
somewhere in `src/`). Exports that no production path uses are listed in §4.

---

## 2. Data and trust flows

The trace below covers submission → quarantine → corpus → engine → reports →
publish. Sealing is AES-256-GCM with a per-row IV (`src/lib/vault.ts:79-85`);
access codes and names are stored as HMAC only (`src/lib/vault.ts:114-120`).

### 2.1 Submission creation

1. Source fetches `GET /api/intake/challenge`; the Worker issues an HMAC-signed
   challenge (`src/routes/intake.ts:142-145`, `src/lib/pow.ts:49-61`).
2. Source solves the PoW in-page (`src/frontend/survey.ts:89-97`) and
   `POST /api/intake`; the Worker verifies PoW, then Turnstile when configured
   (`src/routes/intake.ts:151-158`).
3. The Worker mints an access code, stores **only its HMAC** and returns the
   code once (`src/routes/intake.ts:160-169`; `code_hmac` at
   `src/db/schema.sql:28-36`).
4. No IP, user agent, or referrer is read or logged anywhere in `src/`
   (confirmed by search: no `console.*` calls in `src/`).

### 2.2 Answers and quarantine

5. `POST /:id/steps` resolves the submission by code HMAC
   (`src/routes/intake.ts:85-116`), then scrubs each answer in request memory
   with `quarantineText` (`src/routes/intake.ts:190-197`;
   `src/lib/intake.ts:159-199`). Capitalised name-shaped tokens outside the
   non-name list become `[person A]…`; the raw name is sealed into `entities`
   with a `name_hmac` join key (`src/routes/intake.ts:229-238`).
6. The scrubbed text is sealed and stored as a `messages` row; topics are
   normalised and recorded (`src/routes/intake.ts:223-244`). The per-submission
   write budget is reserved atomically before the batch
   (`src/routes/intake.ts:203-216`).

### 2.3 Rounds and retrigger

7. `POST /:id/rounds` gathers covered topics for the submission family
   (`src/routes/intake.ts:442-450`) and either asks the registry for grounded
   questions or falls back to the static pool
   (`src/lib/rounds.ts:72-123`). Model-authored questions are schema-validated
   and marker-filtered, then served to the source
   (`src/routes/intake.ts:452-465`).
8. At round exhaustion the submission is completed once and retriggered
   (`src/routes/intake.ts:438-440`, `456-458`; `src/lib/retrigger.ts:74-93`).
   The significance judge may only narrow the deterministic floor
   (`src/lib/serve.ts:140-169`; `src/lib/retrigger.ts:108-119`).

### 2.4 Submitter attachments (the documented Principle I carve-out)

9. `POST /:id/attachments` decides the lane, reserves the 200 MB quota in one
   statement, buffers the body, writes raw bytes to a private R2 key, and
   enqueues (`src/routes/intake.ts:271-349`; lane rules
   `src/lib/attachments.ts:19-28`). The raw bytes are **unencrypted** while in
   R2 (`THREAT-MODEL.md:166-180`). The filename is sealed before storage
   (`src/routes/intake.ts:318`).
10. The queue consumer calls `drainAttachmentById`
    (`src/index.ts:876-884`); the lane handler extracts, `applyDrain` runs the
    name-leak gate before anything is stored (`src/lib/drain.ts:66-96`), the
    gated text is sealed as **testimony only** (`src/lib/attachments.ts:148-156`),
    and the raw object is deleted on success (`src/lib/attachments.ts:176`).
    Failure keeps the raw with a `retry_after` set 24 h ahead
    (`src/lib/attachments.ts:186-194`).

### 2.5 Corpus ingestion

11. `POST /api/corpus` is operator-gated (`src/index.ts:160-165`). The body is
    base64 JSON, size-checked before decode (`src/routes/corpus.ts:30-44`), and
    classified (`src/lib/ingest.ts:31-70`).
12. Native text decodes in-request and is gated (`gateCorpusText`) before any
    write (`src/routes/corpus.ts:54-64`). Held lanes write raw bytes to R2,
    enqueue, and record `held`/`pending` (`src/routes/corpus.ts:74-97`). Only
    `parsed` text reaches the FTS mirror, and only after the gate
    (`src/routes/corpus.ts:98-105`).
13. `POST /api/corpus/drain` or the queue consumer drains held docs: bytes from
    R2 → lane handler (`toMarkdown` for documents/sheets/slides, vision for
    images: `src/lib/drain.ts:180-307`) → gate → sealed text + FTS insert +
    raw delete (`src/routes/corpus.ts:176-202`). Failures update the reason and
    stay held (`src/routes/corpus.ts:203-207`). The queue retries on throw and
    acks on success (`src/index.ts:886-889`); `max_retries = 3`,
    `max_batch_size = 5` (`wrangler.toml:25-28`).

### 2.6 Engine

14. `POST /api/engine/angles/propose` (operator-gated, `src/index.ts:169-174`)
    applies the ledger floor, then proposes and stores grounded angles
    (`src/routes/engine.ts:56-83`; `src/lib/angles.ts:29-134`). The sealed
    mirror is opened in memory to feed the proposer
    (`src/lib/angles.ts:40-48`); model exhibits are kept only when the snippet
    occurs in the cited document (`src/lib/serve.ts:107-117`); flagged headings
    are stored but held (`src/lib/angles.ts:108-131`).
15. Approve and review gates protect the queue
    (`src/routes/engine.ts:108-157`). Lines open only on approved angles and a
    Workflow instance is created (`src/routes/engine.ts:159-189`).
16. Completion requires at least one citation and every cited doc must exist
    (`src/routes/engine.ts:211-222`); findings are flagged, sealed, and stored
    held when flagged (`src/routes/engine.ts:226-241`). The spend route is an
    atomic conditional increment (`src/routes/engine.ts:274-307`).
17. The `EngineWorkflow` records telemetry for the line and evaluates report
    frequencies; it does no research itself (`src/index.ts:828-853`).

### 2.7 Reports and publish

18. Evidence is assembled from approved angles and `complete` lines only
    (`src/lib/evidence.ts:17-74`); held lines are excluded at the SQL filter
    (`src/lib/evidence.ts:41`).
19. Publish reads stored config only, evaluates all enabled gates
    (`src/lib/publish.ts:115-119`; `src/lib/reports.ts:70-97`), renders the
    deterministic body, optionally runs the journalist pass, and re-checks the
    model prose for injection markers (`src/lib/publish.ts:121-153`).
20. The version number is allocated atomically and the body sealed into
    `report_versions`; there is no update or delete path for versions
    (`src/lib/publish.ts:158-178`; read at `src/routes/reports.ts:39-60`).
21. The cron trigger and `POST /api/scheduler/evaluate` run `evaluateAll`,
    which applies frequency policy and always writes an `eval_receipts` row
    (`src/index.ts:858-866`; `src/lib/schedule.ts:95-181`). Full-dynamic renders
    carry the danger banner (`src/lib/schedule.ts:85-86`, `162`).

---

## 3. ADR conformance

One row per ADR 0001–0014. "Implemented" means a runtime path in `src/`
enacts the decision; deviations are named with evidence.

| ADR | Decision | Status | Evidence |
|---|---|---|---|
| 0001 | One investigation per installation; BYOK registry; degraded keyless mode | **Implemented, with a limit** | Per-install bindings `wrangler.toml:10-42`; registry `src/lib/setup.ts:30-62`, `src/lib/registry.ts:61-78`; degraded warning `src/lib/registry.ts:68-77`, served at `src/index.ts:296-312`. Limit: "N custom entries" is capped at the two provider slots — `PROVIDER_SLOTS` has two entries (`src/lib/setup.ts:21-24`) and every entry's `secret_slot` is validated against it (`src/lib/setup.ts:43-48`), so N entries can share only two keys. Reordering exists as `reorderProviders` but no route calls it (`src/lib/registry.ts:81-102`; only `test/registry.test.ts:4` imports it). |
| 0002 | Async lanes, vision OCR, two-page multi-modal rescue, pre-mirror gate | **Partially implemented; rescue and native parsing absent** | Lanes `src/lib/ingest.ts:31-70`; off-request parsing `src/index.ts:871-891`; gate before mirror `src/lib/drain.ts:87-95`, `src/routes/corpus.ts:184-195`; per-file statuses `src/routes/corpus.ts:121-135`. No rescue code exists (`rescued` is repurposed for keyless-after-registry vision, `src/lib/drain.ts:278-283`). The named native parsers (`unpdf`/`mammoth`/SheetJS/JSZip) are absent from `package.json:17-24`; document lanes use `toMarkdown` only (`src/lib/drain.ts:181-229`). Uploads are not streamed (`src/routes/corpus.ts:30-44`). |
| 0003 | LLM angles, workflow per research line, ledger-backed judged retrigger, flag-and-gate | **Partially implemented** | Live propose `src/lib/serve.ts:68-128`; grounded storage `src/lib/angles.ts:93-131`; workflow per line `src/routes/engine.ts:178-188`; spend cap `src/routes/engine.ts:282-286`; citations `src/routes/engine.ts:211-222`; judge narrow-only `src/lib/serve.ts:140-169`; auto-retrigger on submission completion `src/lib/retrigger.ts:95-140`. Deviations: the Workflow does no research (`src/index.ts:828-853`); the default propose mode is deterministic (`src/routes/engine.ts:31`); the spend cap is not connected to any code that spends (only the manual route at `src/routes/engine.ts:274-307`); a corpus upload never retriggers (no call in `src/routes/corpus.ts`). |
| 0004 | Five types, manual-first combinable gates, four frequencies, two-tier rewrites, append-only history | **Implemented, with divergence** | Types/renderers `src/lib/reports.ts:191-197`; gates stored with the report `src/routes/reports.ts:93-111`; frequencies `src/lib/schedule.ts:36-73`; append-only `src/lib/publish.ts:158-178`. Divergences: the two-tier route is a `POST /:type/tick` endpoint that nothing feeds from the judge (`src/routes/reports.ts:150-175`); `pending_topics` is never consumed by publish (`src/lib/publish.ts:108-180`); the ADR's "manual approval **or** all automatic gates" (`docs/adr/0004-report-outputs-and-publish-gates.md:25-27`) is coded as an AND of every enabled gate (`src/lib/reports.ts:75-96`). |
| 0005 | Two-phase install; deploy button primary, scoped token fallback; wizard is code; honest teardown receipt | **Partially implemented** | Wizard is code `src/frontend/chrome.ts`; secrets written by Worker code `src/lib/secrets.ts:57-68`, `src/lib/cfapi.ts:146-162`; teardown receipt `src/lib/provision.ts:174-222`. Deviations: no deploy button URL is shipped (only the prose in `deploy-button.md`); the deploy-button path does not create `SERVER_SECRET`/`ENCRYPTION_KEY`/`OPERATOR_TOKEN`, and the runtime provisioner that would is itself gated by `OPERATOR_TOKEN` (`src/index.ts:106-118`, `709-713`; `src/state.ts:51-55`); the wizard has no corpus step (`src/frontend/chrome.ts:215-218`). |
| 0006 | Seven-asset launch pack; URL-only QR; regenerable; zero operator identity | **Implemented** | Seven fields `src/lib/pack.ts:5-13`; bare-URL QR `src/lib/pack.ts:76-78`; structural/identity audit `src/lib/pack.ts:51-93`; rotation `src/routes/launch.ts:152-165`; Host-header steering refused `src/routes/launch.ts:33-42`, `94-106`. |
| 0007 | Registry on the Vercel AI SDK (`ai@7` + `@ai-sdk/openai-compatible@3`) | **Implemented** | `src/lib/serve.ts:10-11`, `229-234`; versions `package.json:18-19`; fall-through semantics `src/lib/serve.ts:242-256`; injectable fetch `src/lib/serve.ts:200`. Minor: ADR records a ~1.3 MB bundle (`docs/adr/0007-ai-sdk-registry.md:44-46`); measured `dist/worker.js` is 2.4 MB. |
| 0008 | BYOK key entry through wizard OAuth consent; transient token; slot name only | **Implemented; live trial pending (as documented)** | Routes `src/index.ts:359-410`, `418-454`, `470-504`; fragment return `src/index.ts:496-497`; secret write `src/lib/secrets.ts:57-68`; tests `test/keyentry.test.ts`, `test/oauth.test.ts`. `CF_OAUTH_CLIENT_ID` defaults empty (`wrangler.toml:54`), so the path is disabled until a var is set. |
| 0009 | Runtime provisioner + teardown via OAuth consent; persisted receipt; Worker deleted last | **Implemented at the route level; no UI caller; re-provision is destructive** | Routes `src/index.ts:709-801`; adapter `src/lib/cfapi.ts`; receipt persistence `src/index.ts:728-733`; Worker deleted last `src/lib/provision.ts:209-211`. Deviations: the wizard never calls `/api/provision` (search of `src/frontend/chrome.ts` finds no reference); the OAuth default scopes are not provisioning scopes (`src/lib/oauth.ts:13` vs `src/lib/scopes.ts:6-14`); generated secrets are unconditionally overwritten on re-run (`src/lib/cfapi.ts:155-161`). |
| 0010 | Journalist pass: one pass per report type; per-pass cap; cite-bound; annotate-uncited then strip; timeline records; snapshot lead | **Partially implemented** | Pass `src/lib/pass.ts:106-206`; grounding `src/lib/pass.ts:150-151`; draft annotate/publish strip `src/lib/pass.ts:194-205`; timeline entries `src/lib/pass.ts:153-181`, `209-231`; snapshot lead `src/lib/pass.ts:183-186`; held lines excluded `src/lib/evidence.ts:41`. Deviations: the pass is not a Workflow step (runs inline at `src/lib/publish.ts:127`; `EngineWorkflow` has no pass step, `src/index.ts:828-853`); there is no per-pass spend cap (`src/lib/pass.ts` has none); the "Workers AI fallback" for prose does not exist (`src/lib/providers.ts:39-53` returns only registry clients); stored entries are never read or edited by production code (`src/lib/pass.ts:215-231`; sole reader is a test, `test/pass.test.ts:193`). |
| 0011 | Native parse + `toMarkdown` fallback + browser PDF.js rasterisation + capability tags | **Partially implemented** | `toMarkdown` lane `src/lib/drain.ts:181-229`; vision lane `src/lib/drain.ts:231-300`; capability routing `src/lib/lanes.ts:24-26`, `src/lib/serve.ts:202-204`; browser tools `src/frontend/pdf-tools-entry.ts`; held-with-reason `src/lib/drain.ts:292-298`. Deviations: no native server-side parse exists (only `toMarkdown`); the wizard never asks for capabilities (`src/frontend/chrome.ts:104-139`) and `/api/providers/key` has no `capabilities` field (`src/index.ts:342-357`), so capability tagging is reachable only by a hand-written `/api/setup` call; **no `pdf.worker.mjs` asset is served** (routes at `src/index.ts:152-154`; no `[assets]` in `wrangler.toml`) while the bundle dynamically imports `this.workerSrc`, so the browser PDF path is likely broken at runtime — **unverified** (no browser test). |
| 0012 | Submitter file uploads; controlled exception; private R2 then OCR then delete; 24 h retry window; 50 MB/200 MB caps | **Partially implemented** | Routes `src/routes/intake.ts:268-377`; caps `src/lib/attachments.ts:14-15`; sealed filename `src/routes/intake.ts:318`; gate then testimony-only `src/lib/attachments.ts:141-176`; delete on success `src/lib/attachments.ts:176`. Deviations: "streamed, not buffered" (`docs/adr/0012-submitter-file-uploads.md:21-24`) is false — the route buffers (`src/routes/intake.ts:298`); "then deletes them" after the 24 h window (`docs/adr/0012-submitter-file-uploads.md:25-26`) has no implementation — nothing sweeps expired windows (only a later drain can, `src/lib/attachments.ts:86-93`, and `scheduled()` only evaluates reports, `src/index.ts:858-866`); the doc names docx/xlsx but pptx is also accepted (`src/lib/attachments.ts:26`). |
| 0013 | OAuth client switches to PKCE (S256), no embedded secret | **Not implemented** | No `code_challenge`, `code_verifier`, or `code_challenge_method` anywhere in `src/` (search). `exchangeOAuthCode` still sends an optional `client_secret` (`src/lib/oauth.ts:70-76`) and the only comment referencing PKCE is a stale ADR-0008 note (`src/lib/oauth.ts:70-71`). `test/oauth.test.ts:94` asserts the secret-bearing body. |
| 0014 | AGPL-3.0; squashed-history public repo; CI gates; publication is a human step | **Implemented** | `LICENSE` (AGPL-3.0 text); CI `/.github/workflows/ci.yml:10-33`; weekly runtime smoke `ci.yml:6-7`, `23-33`; contributing/security/templates present (`CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/`); `test/opensource.test.ts` asserts the surface. `scripts/split-repo.sh` is absent here, which the test tolerates in the standalone layout (`test/opensource.test.ts:67-79`). |

---

## 4. Claim vs reality

### 4.1 Statements the code does not bear out

Each row states its resolution: **resolved** means the claim now matches the
code (with the landing that fixed it), **open** means it is tracked by the
named ticket. Documentation rows for `README.md`, `SECURITY.md` and
`RUNBOOK.md` were corrected by A7 (#8) on 2026-09-17.

| Claim | Where claimed | What the code shows | Resolution |
|---|---|---|---|
| "Identifying originals are never stored" | `README.md:8-9` | True for free text, false for submitter attachments: raw pages/PDFs sit unencrypted in R2 until drain (`THREAT-MODEL.md:166-180`; `src/routes/intake.ts:337-344`). The README does not carry this documented exception. | **Resolved — A7 (#8)**: README now names the ADR-0012 attachment exception, its bounded window and the sweep. |
| "Worker token — paste the operator token the provision step showed" | `RUNBOOK.md:29-31` | No code path ever returns a generated secret value (`src/lib/cfapi.ts:146-162`; `src/lib/provision.ts:56-60`). The receipt carries `{slot, set, generated}` only. | **Resolved — A1 (#2), restated by A7 (#8)**: the boot step has the operator choose the token and states the installation never returns it. |
| "Empty runs degraded: … Workers AI as the keyless tier" | `RUNBOOK.md:32-34` | The `AI` binding serves document conversion and OCR only (`src/lib/drain.ts:180-300`; `src/lib/lanes.ts:12-34`). Angles, rounds, and report prose degrade to deterministic/static output with no Workers AI call (`src/lib/providers.ts:39-53`; `src/lib/rounds.ts:79`). | **Resolved — A7 (#8)**: the runbook scopes Workers AI to the ingestion lanes and names the deterministic degradation. |
| "Flags are admin-only hints; no code path hides, deletes, or gates on a flag" | `SECURITY.md:36` | Flags gate: flagged angles list as `held` and are refused approval (`src/routes/engine.ts:98-100`, `118-121`); flagged lines are stored `held` and excluded from evidence (`src/routes/engine.ts:230`; `src/lib/evidence.ts:41`); flagged model prose is dropped for the deterministic body (`src/lib/publish.ts:139-147`). | **Resolved — A7 (#8)**: the security table now describes the gating holds. |
| "model output is … never used to author question text the operator did not write" | `SECURITY.md:47-49` | Model-authored rounds are served to sources (`src/lib/rounds.ts:89-94`, `119-122`; `src/routes/intake.ts:453-465`). `THREAT-MODEL.md:64-66` concedes this; `SECURITY.md` contradicts it. | **Resolved — A7 (#8)**: the LLM02 mapping now names model-authored follow-ups and their validation. |
| "SQL injection … A grep gate asserts this in review" | `SECURITY.md:65-66` | No such gate exists in CI (`ci.yml:10-21`) or in the tests (search found none). Dynamic SQL fragments are count-derived placeholders plus a constant table list (`src/routes/intake.ts:445`; `src/lib/retrigger.ts:63-68`; `src/index.ts:534-548`). | **Resolved — A7 (#8)**: claim removed; the mapping names the real controls and says there is no gate. |
| "At-rest storage is ciphertext-only | `/api/audit/ciphertext` reports envelope counts…" | `SECURITY.md:37` | The endpoint inspects four tables (`src/index.ts:615-620`), while five more sealed columns exist (`attachments.filename`, `corpus_docs.filename`, `angles.rationale_envelope`, `research_lines.findings_envelope`, `report_entries.entry_envelope`: `src/index.ts:540-547`). The smoke script's "ciphertext-only" receipt therefore under-covers. | **Resolved — A13 (#14)**: the endpoint now inspects every sealed column by the schema conventions, receipts reconcile per column, and a coverage gate fails on a new sealed column the audit does not name. |
| "read-only tools only; `maxSteps`/length caps; … tool-vocabulary leakage" | `THREAT-MODEL.md:60-63` | No tools and no multi-step agent exist; all model calls are single-shot completions (`src/lib/serve.ts:260-289`). `toolCalls` is a telemetry column, not a cap. Output policing covers injection markers only (`src/lib/engine.ts:142-175`). | **Resolved — B1 (#19), B2 (#20)**: research lines drive read-only corpus tools under step, token, spend and wall-time caps, and over-cap lines halt as held with `capped` telemetry. |
| "a lifecycle rule must abort incomplete multipart uploads" | `THREAT-MODEL.md:82-83` | No lifecycle configuration exists in `wrangler.toml` or `src/lib/cfapi.ts`. | **Open — unclaimed**, and now load-bearing: chunked uploads are stored as multipart parts, and a crashed upload relies on the explicit `abort()` on failure paths (`src/lib/upload.ts`) rather than a bucket lifecycle rule. |
| "Corpus uploads … retrigger" (new material incl. a corpus upload) | `docs/adr/0003-digest-angles-and-research-engine.md:31-36` | Corpus upload never calls retrigger (`src/routes/corpus.ts` has no call); only submission/round completion and the manual route do (`src/routes/intake.ts:438-440`; `src/routes/engine.ts:350-373`). | **Open — unclaimed.** |
| "streamed, not buffered" for submitter uploads; "An upload streams the bytes to R2" | `docs/adr/0012-submitter-file-uploads.md:21-24`; `docs/adr/0002-corpus-ingestion-and-ocr.md:22-24` | Both paths buffer: submitter attachments call `arrayBuffer()` (`src/routes/intake.ts:298`); corpus uploads parse a base64 JSON body (`src/lib/ingest.ts:98-102`; `src/routes/corpus.ts:30-44`). | **Resolved — A14 (#15), A15 (#16)**: submitter attachments and corpus uploads stream into R2 through a counting, capping transform; the corpus route carries the filename in the `x-filename` header, counts the raw body, and the base64 JSON framing is retired. |
| "then deletes them" after the 24 h retry window | `docs/adr/0012-submitter-file-uploads.md:25-26` | `retry_after` only gates re-drain attempts (`src/lib/attachments.ts:86-93`); no scheduled or queued sweep deletes expired raw bytes (`src/index.ts:858-891`). A file that is never drained again stays in R2 indefinitely. | **Resolved — A3 (#4)**: the scheduled raw-byte sweep deletes expired bytes and receipts the deletion. |
| "Angles are LLM-proposed end-to-end … there is no separate deterministic digest stage" | `docs/adr/0003-digest-angles-and-research-engine.md:22-25` | The deterministic proposer is the default (`src/routes/engine.ts:31`; `src/lib/engine.ts:57-84`); the LLM proposer is opt-in `mode: "live"` and falls back to the floor on any error (`src/lib/serve.ts:85-104`). | **Resolved in part — B1 (#19)**: lines research autonomously to a finding with the deterministic floor as the keyless tier (ADR-0015's stance). LLM angle proposal remains an opt-in `mode: "live"` choice, not the default. |
| "One pass per report type, each a resumable Workflow step … a per-pass spend cap; … Workers AI fallback" | `docs/adr/0010-journalist-pass.md:17-20` | The pass runs inline in the HTTP/scheduler publish path (`src/lib/publish.ts:127`); there is no pass step in `EngineWorkflow` (`src/index.ts:828-853`); no per-pass cap exists; the fallback is the deterministic render, not Workers AI (`src/lib/providers.ts:39-53`). | **Resolved — B12 (#30)**: the pass is a memoised per-type Workflow step with a token cap; the fallback stays the deterministic render by design. |

### 4.2 Dead or unreferenced code

| Export | Location | Evidence |
|---|---|---|
| `reorderProviders` | `src/lib/registry.ts:81-102` | **Resolved by B4 (#22)**: the operator-gated `POST /api/providers/reorder` route calls it. |
| `ReportVersionSchema` | `src/lib/publish.ts:190-193` | No importer. |
| `pageCount` | `src/frontend/pdf-tools-entry.ts:55-58` | Exposed on `window.SurveyorPdf` but called by neither `survey.ts` nor `uploader.ts`. |
| `checkScopes` / `ProvisionPlan.grantedScopes` | `src/lib/scopes.ts:23-26`; `src/lib/provision.ts:113-117` | Production never passes `grantedScopes` (`src/index.ts:722-726`); tests only (`test/journey.test.ts:108-118`, `test/provision.test.ts:204-217`). |
| `report_entries` table | `src/db/schema.sql:139-145` | **Resolved by B12 (#30)**: the timeline render reads the stored entries as its source of truth (`src/lib/pass.ts` `renderStoredTimeline`). |
| `pending_topics` | `src/db/schema.sql:112` | Written by `/tick` and cleared on publish (`src/routes/reports.ts:158-168`; `src/lib/publish.ts:175`); never used to decide anything. |

No `TODO`, `FIXME`, `HACK`, or `XXX` markers exist anywhere in `src/`, `test/`,
`scripts/`, or `docs/` (search). The only close matches are test `vi.stubGlobal`
calls, HTML `placeholder` attributes, and "stub token endpoint" prose in
`docs/adr/0008-byok-key-entry.md:62`.

### 4.3 Suggested test coverage

Test files are one-per-domain at 36 files. Direct-import coverage:

| Module | Covering test(s) | Notes |
|---|---|---|
| `src/lib/angles.ts` | `test/retrigger.test.ts`, `test/engine-routes.test.ts` | indirect |
| `src/lib/attachments.ts` | `test/attachments.test.ts` | direct |
| `src/lib/cfapi.ts` | `test/provision-runtime.test.ts` | indirect (via routes) |
| `src/lib/drain.ts` | `test/drain.test.ts` | direct |
| `src/lib/engine.ts` | `test/engine.test.ts` | direct |
| `src/lib/evidence.ts` | `test/pass.test.ts` | direct |
| `src/lib/ingest.ts` | `test/ingest.test.ts` | direct |
| `src/lib/intake.ts` | `test/intake.test.ts`, `test/ingest.test.ts` | indirect |
| `src/lib/lanes.ts` | `test/drain.test.ts`, `test/attachments.test.ts` | indirect |
| `src/lib/net.ts` | `test/setup.test.ts`, `test/registry.test.ts`, `test/providers.test.ts` | indirect |
| `src/lib/oauth.ts` | `test/oauth.test.ts` | indirect (via routes) |
| `src/lib/pack.ts` | `test/pack.test.ts` | direct |
| `src/lib/pass.ts` | `test/pass.test.ts` | direct |
| `src/lib/pow.ts` | `test/pow.test.ts` | direct |
| `src/lib/providers.ts` | `test/providers.test.ts` | direct |
| `src/lib/provision.ts` | `test/provision.test.ts`, `test/journey.test.ts` | direct |
| `src/lib/publish.ts` | `test/pass.test.ts` | direct |
| `src/lib/registry.ts` | `test/registry.test.ts` | direct |
| `src/lib/reports.ts` | `test/reports.test.ts` | direct |
| `src/lib/retrigger.ts` | `test/retrigger.test.ts` | direct |
| `src/lib/rounds.ts` | `test/rounds.test.ts` | indirect |
| `src/lib/schedule.ts` | `test/schedule.test.ts`, `test/scheduler.test.ts` | direct/route |
| `src/lib/scopes.ts` | `test/journey.test.ts`, `test/provision.test.ts` | direct |
| `src/lib/secrets.ts` | `test/keyentry.test.ts` | indirect |
| `src/lib/serve.ts` | `test/serve.test.ts`, `test/chain.test.ts` | direct |
| `src/lib/setup.ts` | `test/setup.test.ts`, `test/worker.test.ts` | direct |
| `src/lib/smoke.ts` | `test/smoke.test.ts` | direct |
| `src/lib/telemetry.ts` | `test/registry.test.ts` | direct |
| `src/lib/vault.ts` | `test/vault.test.ts` | direct |
| `src/routes/intake.ts` | `test/intake.test.ts`, `test/security.test.ts`, `test/attachments.test.ts` | route |
| `src/routes/corpus.ts` | `test/corpus.test.ts`, `test/drain.test.ts` | route |
| `src/routes/engine.ts` | `test/engine-routes.test.ts` | route |
| `src/routes/reports.ts` | `test/report-routes.test.ts`, `test/scheduler.test.ts` | route |
| `src/routes/launch.ts` | `test/launch.test.ts` | route |
| `src/frontend/chrome.ts` | `test/oauth.test.ts`, `test/worker.test.ts` | shell string assertions only — no DOM execution |
| `src/frontend/survey.ts` | `test/survey.test.ts` | shell string assertions only |
| `src/frontend/uploader.ts` | `test/uploader.test.ts` | shell string assertions only |
| `src/frontend/pdf-tools-entry.ts` | `test/uploader.test.ts` | bundle is served and parses; no browser execution |

Entry points with no test at all:

- the queue consumer `src/index.ts:871-891` (the drain functions it calls are
  tested, but `msg.ack()`/`msg.retry()` are not);
- `scheduled()` `src/index.ts:858-866` (`evaluateAll` is tested via the HTTP
  route, not the cron handler);
- `EngineWorkflow.run` `src/index.ts:828-853`;
- the browser execution of `pdf-tools-entry.ts` (only the served bytes are
  checked, `test/uploader.test.ts:23-32`);
- all three live-trail surfaces: OAuth round trip, provisioner endpoints, and
  browser PDF extraction are explicitly documented as live-trial-pending
  (`docs/adr/0008-byok-key-entry.md:60-62`; `docs/adr/0009-runtime-provisioner.md:49-53`).

### 4.4 Contradictions between documents

1. `SECURITY.md:36` ("flags never … gate") contradicts `THREAT-MODEL.md:119-125`
   ("suspicious lines are held from every report pending operator review") and
   `docs/adr/0003-digest-angles-and-research-engine.md:39-42`. The code follows
   the ADR (`src/routes/engine.ts:226-230`; `src/lib/evidence.ts:41`).
2. `SECURITY.md:47-49` (model never authors question text) contradicts
   `THREAT-MODEL.md:64-66` (a jailbreak "may still influence question
   wording"). The code follows the threat model (`src/lib/rounds.ts:89-94`).
3. `README.md:8-9` and `SECURITY.md:31` ("originals never persisted")
   contradict `docs/adr/0012-submitter-file-uploads.md:54-56` and
   `THREAT-MODEL.md:166-180` (raw submitter pages in R2 for a window).
4. `RUNBOOK.md:29-31` (the provision step shows the operator token) contradicts
   `docs/adr/0009-runtime-provisioner.md:23-26` (values never appear in a
   receipt, log, or return).
5. `RUNBOOK.md:114-116` ("there is no development fallback") contradicts
   `.github/workflows/niro-find.yml:5-7` ("boots with development fallbacks").
6. `docs/adr/README.md:34-43` ("Known deviations") is stale: it lists 0002's
   "no vision, no `env.AI`" after `src/lib/drain.ts:195-198`, `264-268`
   implemented it; 0003's "the judge never auto-invokes" after
   `src/lib/retrigger.ts:112-118` auto-invokes it; and 0004's "journalist pass
   does not exist" after ADR-0010 implemented it. It also says 0005 is resolved
   by ADR-0009, which is true only at the route level (§5, finding 1).
7. `docs/adr/0004-report-outputs-and-publish-gates.md:58-60` says the
   journalist pass is "not yet delivered", superseded by ADR-0010.
8. ADR-0002's two-page multi-modal rescue (`docs/adr/0002-corpus-ingestion-and-ocr.md:29-31`)
   is not marked superseded by ADR-0011, and neither exists in the code.
9. References to `.specify/memory/constitution.md` (`docs/adr/README.md:5-6`),
   `specs/002-investigation-platform/plan.md`
   (`docs/adr/0012-submitter-file-uploads.md:39-40`), and
   `.scratch/cloudflare-native/…` (many ADRs) point at paths that do not exist
   in this repository (none of `.specify/`, `specs/`, `.scratch/` is present).
10. `evidence/runtime-smoke.md:3` cites commit `6adec7c`, which does not exist
    in this repository's history (history begins at `fcb4324`). The evidence
    cannot be reproduced from this repo; the script itself still passes today
    per the CI wiring, but the recorded run is unverifiable here.

**Status (2026-09-17).** A7 (#8) resolved items 1–4 by correcting
`SECURITY.md`, `README.md` and `RUNBOOK.md` (each document carries an Errata
section). Item 5 is answered by the harness itself: `niro/harness/start.sh`
generates `SERVER_SECRET`/`ENCRYPTION_KEY` and supplies them as vars, and
`state.ts` genuinely has no development fallback, so the RUNBOOK statement is
correct and the workflow comment is loose wording. Items 6–9 are the ADR
corpus cleanup in A8 (#9); item 10 stands as an unverifiable historical
receipt.

---

## 5. Gaps and inconsistencies, ranked

### Critical

1. **Fresh installs are locked out of configuration.** `SERVER_SECRET`,
   `ENCRYPTION_KEY`, and `OPERATOR_TOKEN` are only ever minted by
   `POST /api/provision` (`src/lib/cfapi.ts:146-162`;
   `src/index.ts:696-704`), but that route requires `OPERATOR_TOKEN`
   (`src/index.ts:709-713`; `src/index.ts:106-118`) and neither the deploy
   button (`deploy-button.md:17-25`) nor `wrangler deploy` (`RUNBOOK.md:12-23`)
   sets those secrets. `state.ts:51-55` refuses to boot without them, so
   `/api/status` reports `provisioned: false` and the wizard cannot write
   (`src/frontend/chrome.ts:84-91`). `RUNBOOK.md:29-31` tells the operator to
   paste a token that no code path ever reveals. There is no documented
   `wrangler secret put` step either. The runtime provisioner is unreachable on
   a fresh install.
2. **Re-running the provisioner silently rotates the master keys.**
   `putSecret(slot, true)` always generates a new value and PUTs it
   (`src/lib/cfapi.ts:155-161`), with no existence check
   (`src/lib/provision.ts:164-169`). Re-running `/api/provision` replaces
   `SERVER_SECRET`, `ENCRYPTION_KEY`, and `OPERATOR_TOKEN` in place: the
   operator token stops working immediately (lockout), and every envelope
   sealed under the previous `ENCRYPTION_KEY` becomes unreadable unless the old
   kit was saved and `/api/audit/reseal` is run (`src/index.ts:550-597`). The
   receipt reports only slot names and booleans, so the new values are not
   recoverable from the response.

### High

3. **Submitter attachment raw bytes have unbounded retention.** ADR-0012
   promises deletion after a 24 h retry window
   (`docs/adr/0012-submitter-file-uploads.md:25-26`), but `retry_after` only
   prevents re-drain within the window (`src/lib/attachments.ts:86-93`); no
   scheduled or queued job deletes expired raw objects (`src/index.ts:858-891`).
   A failed file that is never drained again stays in R2 unencrypted
   indefinitely (`src/lib/attachments.ts:186-194`).
4. **The browser PDF path is likely non-functional as shipped.** The bundle
   dynamically imports `this.workerSrc` (verified in `dist/pdf-tools.txt`), the
   entry code never sets `workerSrc`
   (`src/frontend/pdf-tools-entry.ts:9-12`), and no route serves
   `pdf.worker.mjs` (`src/index.ts:152-154`; no `[assets]` in
   `wrangler.toml`). `isEvalSupported: false` does not remove the worker
   dependency. This underpins both ADR-0011's rasterisation and ADR-0012's
   "digital PDFs never leave the device" claim. **Unverified at runtime** —
   there is no browser test; the risk is inferred from the served bundle and
   routes.
5. **Research lines perform no research and the spend cap is inert.** The Workflow
   records telemetry and evaluates report frequencies only
   (`src/index.ts:828-853`); a line completes solely through an operator POST
   that supplies findings and citations (`src/routes/engine.ts:191-243`). The
   cap is enforced on the manual `/spend` route
   (`src/routes/engine.ts:282-286`) but no code path actually spends against
   it. README's "grounded research" pillar (`README.md:13-14`) and ADR-0003's
   workflow-per-line promise (`docs/adr/0003-digest-angles-and-research-engine.md:27-30`)
   overstate the build.

### Medium

6. **ADR-0013 (PKCE) is not implemented.** No PKCE parameters exist in `src/`
   (search); the flow still uses an optional shared `client_secret`
   (`src/lib/oauth.ts:70-76`), and the tests assert that behaviour
   (`test/oauth.test.ts:94`). The stale comment at `src/lib/oauth.ts:70-71`
   still points at the superseded ADR-0008 open question.
7. **ADR-0010's Workflow-step, per-pass-cap, and Workers AI fallback claims are
   absent.** The pass runs inline (`src/lib/publish.ts:127`), has no cap
   (`src/lib/pass.ts`), and degrades to a deterministic render rather than
   Workers AI (`src/lib/providers.ts:39-53`). Stored timeline entries are
   write-only (`src/lib/pass.ts:215-231`).
8. **`SECURITY.md` makes three claims the code contradicts** (flags never gate;
   model never authors questions; a SQL grep gate exists) — see §4.1 with
   citations `src/routes/engine.ts:118-121`, `230`; `src/lib/rounds.ts:89-94`;
   `ci.yml:10-21`.
9. **The runtime provisioner cannot work with the shipped OAuth defaults.**
   `DEFAULT_SCOPES` is `workers-scripts.write account.read`
   (`src/lib/oauth.ts:13`), while provisioning needs the seven scopes in
   `src/lib/scopes.ts:6-14` mapped to concrete Cloudflare permissions. No
   mapping code exists in `src/lib/cfapi.ts`; the abstract scope list is only
   checked when a caller passes `grantedScopes`, which production never does
   (`src/lib/provision.ts:113-117`), contrary to `deploy-button.md:29-32`
   ("The mapping lives in `src/lib/scopes.ts`").
10. **"N custom provider entries" is capped at two secret slots and capability
    tagging has no UI path.** `PROVIDER_SLOTS` has exactly two slots
    (`src/lib/setup.ts:21-24`); every entry is validated against it
    (`src/lib/setup.ts:43-48`), and `/api/providers/key` accepts no
    `capabilities` field (`src/index.ts:342-357`). The wizard asks for neither
    (`src/frontend/chrome.ts:104-139`), so a `vision` tag can only be set by a
    hand-written `/api/setup` request
    (`docs/adr/0011-ingestion-browser-rasterisation.md:22-24`).
11. **Corpus uploads do not retrigger research** (ADR-0003's third trigger,
    `docs/adr/0003-digest-angles-and-research-engine.md:31-36`): no call in
    `src/routes/corpus.ts`.
12. **The two-tier update route is disconnected.** `/tick` exists
    (`src/routes/reports.ts:150-175`) but nothing derives `new_topics` from the
    significance judge, and `pending_topics` never influences a publish
    (`src/lib/publish.ts:108-180`). ADR-0004's "routed by the significance
    judge" (`docs/adr/0004-report-outputs-and-publish-gates.md:34-37`) is not
    enacted.
13. **The at-rest audit under-covers the sealed surface.** Five sealed columns
    are outside `/api/audit/ciphertext`
    (`src/index.ts:540-547` vs `615-620`), including attachment filenames and
    corpus filenames, while `SECURITY.md:37` presents the endpoint as the
    at-rest proof.
14. **Identifier-bearing values travel in query strings.** Access codes and
    filenames for attachments are query parameters
    (`src/routes/intake.ts:276`, `283-287`; `src/frontend/survey.ts:208-210`),
    so Cloudflare's edge sees them in request URLs even though the application
    logs nothing and the DB stores the filename sealed. This sits awkwardly
    against THREAT-MODEL T1's storage-leak mitigation
    (`THREAT-MODEL.md:43-54`).
15. **The model-call fetch follows redirects; validation does not.** The
    save-time probe refuses redirects (`src/lib/registry.ts:139-142`), but the
    AI SDK client is constructed without a redirect policy
    (`src/lib/serve.ts:229-234`), so a redirect from a configured base URL is
    followed with the provider key attached. DNS-rebinding is also
    unmitigated by `src/lib/net.ts` (host-name-only checks); the committed
    Niro profile records it as a demoted concern (`niro/niro.yaml:11-18`).
    **Unverified live.**
16. **The corpus/attachment upload paths buffer whole files**, contrary to the
    ADRs (`src/routes/corpus.ts:30-44`; `src/routes/intake.ts:298`). A 50 MB
    attachment or ~33 MB base64 body plus extraction is buffered in a 128 MB
    isolate shared across requests; the ADRs' resource-floor reasoning
    (`docs/adr/0002-corpus-ingestion-and-ocr.md:10-14`) assumed streaming.

### Low

17. **No vulnerability-reporting contact ships.** `SECURITY.md:11-12` still
    says the address will be added at the R8 release, but R8 has shipped
    (ADR-0014, `LICENSE`).
18. **Dead exports and write-only storage** (`reorderProviders`,
    `ReportVersionSchema`, `pageCount`, `report_entries`, `pending_topics`) —
    §4.2.
19. **Documentation set is stale and self-referential outside the repo** —
    §4.4 items 6–10, including the dangling constitution/spec/wayfinder paths
    and the unreproducible smoke evidence commit.
20. **No tests for the three runtime entry points** (queue consumer,
    `scheduled()`, `EngineWorkflow`) and none for browser execution. All 268
    tests run against `FakeD1` (real `node:sqlite`) and `FakeR2` facades
    (`test/helpers/d1.ts:1-4`; `test/helpers/r2.ts:1-2`), so Workers-specific
    behaviour (queue ack/retry, Workflow resume, R2 semantics) is not
    exercised.

---

## 6. Scope note — what this audit did not cover

- **No live Cloudflare account.** The deploy-button path, Cloudflare API
  endpoint shapes in `src/lib/cfapi.ts`, D1/R2/Queue/Workflow behaviour in
  production, the OAuth consent round trip, Turnstile verification, Workers AI
  models, and cost ceilings were not exercised. ADR-0008/0009 and
  `THREAT-MODEL.md:196-201` already declare these live-trial-pending; this
  audit did not close them.
- **No browser execution.** The PDF.js worker concern in finding 4 is inferred
  from the built bundle and the routes; it was not observed in a browser.
- **No penetration test.** The `niro/` harness and
  `.github/workflows/niro-find.yml` were read for what they claim and wire, but
  no Niro run was performed and the findings from the two remediated pentests
  were not re-derived.
- **No dependency or supply-chain inspection.** `package-lock.json` contents,
  transitive advisories, and the `npx wrangler`/`curl | sh` installation paths
  used by `scripts/runtime-smoke.sh:25` and `.github/workflows/niro-find.yml:167`
  were not audited beyond noting them.
- **No tests of document rendering fidelity, accessibility, internationalisation,
  performance, or cost.**
- **No audit of the private monorepo.** The referenced constitution
  (`.specify/memory/constitution.md`), the specification, and the wayfinder
  tickets are not present in this repository and could not be checked against
  the code.
- **No source changes.** Everything above is read-only analysis plus
  `typecheck`/`test`/`build`.
