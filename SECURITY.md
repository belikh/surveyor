# Security Policy — Surveyor (investigation platform)

**Status**: audited against the code 2026-09-17 (A7, #8). Companion to
`THREAT-MODEL.md` and constitution Principle II (secrets never in transcripts)
and V (test-verified security). Australian English.

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

- Use **Security → Report a vulnerability** (private advisory) on this
  repository instead of a public issue. A maintainer contact address will be
  added before the project is promoted beyond this repository.
- We aim to acknowledge within 7 days and to coordinate disclosure after a fix.
- Never include a real secret, a live submission, or a source's data in a report;
  use synthetic fixtures.

## Supported versions

The platform ships as one installation per investigation. Security fixes land on
`main` and are deployed by operators through their own redeploy path (see
`README.md`). There is no hosted version to patch on the operator's behalf.

## Security properties and how they are enforced

| Property | Enforcement |
|---|---|
| Raw submitter-identifying originals never persisted — one controlled exception | Free text is anonymised in request memory and only AES-256-GCM envelopes are written. Submitter attachments are the user-approved Principle I exception (ADR-0012): the raw file is held unencrypted in private R2 only until its lane drains, is never sent to a text prompt or logged, and is deleted on success or by the scheduled raw-byte sweep after the retry window; extracted text is quarantined testimony only, never corpus. |
| Secrets never in transcripts, rows, logs, or receipts | Secret store only; slot names/booleans elsewhere; constant-time operator compare |
| Names never in the mirror or agent context | Name-leak gate after extraction, before any mirror/embedding/prompt write |
| Untrusted content is data, never instructions | Delimited framing, read-only corpus tools, Zod at every boundary, output policing, `textContent`-only rendering |
| Mirror purity | Mirror scan test proves zero entity names present |
| Flags gate, and never act unattended | A flagged angle lists as `held` and approval is refused until a reviewer clears the flags; a flagged research line stores as `held` and is excluded from evidence; flagged model prose falls back to the deterministic body. Flags never publish, delete, or rewrite by themselves |
| At-rest storage is ciphertext-only where audited | `/api/audit/ciphertext` reports envelope counts and malformed counts, without decrypting, for `messages.body_envelope`, `corpus_docs.text_envelope`, `entities.name_envelope` and `report_versions.body_envelope`. The remaining sealed columns (`attachments.filename`, `corpus_docs.filename`, `angles.rationale_envelope`, `research_lines.findings_envelope`, `report_entries.entry_envelope`) are not yet in the receipt — #14 extends the audit to every sealed column |
| Corpus custody | Constitution Principle XI ledger; raw held bytes in the operator's private R2 with a bounded retention window enforced by the scheduled sweep |

## OWASP LLM Top 10 mapping

- **LLM01 Prompt injection** — everything a submitter, document, or model
  produces is data. No side-effecting tools; read-only corpus tools only;
  `maxSteps` and length caps; output schema validation and injection-marker
  policing; fenced, never auto-published. Tests: injection fixture suite asserts
  zero rule-following and no system-prompt leakage.
- **LLM02 Insecure output handling** — model output is never rendered as HTML
  (`textContent` only), never executed, and never published without passing
  gates. Follow-up rounds *may* be model-authored (`src/lib/rounds.ts`): they
  are schema-validated, filtered against injection markers and settled topics,
  grounded in gated mirror excerpts, and fall back to the static pool on any
  failure, so a model can influence question wording but never makes it
  unfiltered to a source (THREAT-MODEL T2).
- **LLM06 Sensitive information disclosure** — submitter free text is
  anonymised before any provider transit; the corpus path sends gated excerpts
  only. One documented exception: a submitter attachment's bytes reach the OCR
  provider before the name gate can read them (ADR-0012's accepted trade-off;
  the raw is never sent to a text prompt). Prompts never contain quarantined
  names; secrets never enter a prompt.
- **LLM08/LLM09 (agency, overreliance)** — the agent is read-only and bounded;
  the significance judge may only narrow, never widen; findings are marked
  untrusted; the operator reviews before spend and before publish.

## Web vulnerability mapping

- **XSS** — CSP `default-src 'none'; script-src 'self'`; all rendering via
  `textContent`; no `innerHTML`; no external assets (Turnstile is the sole
  documented third-party origin, script/frame only, and only when enabled).
- **CSRF** — APIs are JSON, same-origin, authorisation is a bearer token held in
  memory (not a cookie), so there is no ambient credential to forge. Operator
  routes are disabled-until-set and token-gated.
- **SQL injection** — parameterised D1 statements only. The few dynamic SQL
  fragments are count-derived placeholders and constant table or column lists
  (`src/routes/intake.ts`, `src/lib/retrigger.ts`, `src/index.ts` reseal), never
  request-controlled identifiers, and are covered by route tests. There is no
  automated grep gate.
- **SSRF** — custom provider base URLs are validated at save time (https to a
  public host) and the save-time probe refuses redirects; the provisioner calls
  only Cloudflare API endpoints. The live model-call client does not yet refuse
  redirects (#13) — until it does, a configured provider that redirects a call
  could send the request (and its key) to another host.

## Secrets and tokens

- `SERVER_SECRET`, `ENCRYPTION_KEY` — minted in-flight at boot (or deliberate
  rotation) and never shown; `OPERATOR_TOKEN` is the operator's own choice,
  entered at boot. No code path returns a secret value: primary receipts carry
  slot names and booleans only, and values are never persisted to D1.
- `GROQ_API_KEY`, `TOKENROUTER_API_KEY` — operator-supplied through the
  wizard's key entry; written to the secret store; never persisted to D1.
  `TURNSTILE_SECRET` is set the same way as the other master secrets and never
  leaves the store.
- Token-paste installs: use a short-lived scoped token and revoke it immediately
  after provisioning (guidance is served by the installation).
- Never paste a secret value into a transcript, issue, commit, test, or report.

## Supply chain

- Dependencies are pinned in `package-lock.json`; CI runs `npm ci` (not
  `npm install`) so the lock is authoritative.
- Where a mature library exists, it is used (constitution IV); hand-rolled
  exceptions are enumerated in the constitution and covered by tests.
- Ingestion lane libraries (added by R6) parse hostile input; they run off the
  request path behind size caps and the pre-mirror gate.

## CI gates

`npm ci && npm run typecheck && npm test && npm run build` must be green on every
push/PR touching the platform, with `npm run smoke:runtime` on a slower schedule
(R8/FR-043). The local-runtime smoke boots workerd and exercises the
ciphertext-only audit and header policy, plus the queue consumer, Workflow
entry and R2 range and delete semantics (A10).

## Errata

Corrections made when this document was audited against the code (A7, #8);
each names the claim that changed.

- **2026-09-17** — "Flags never auto-action … no code path … gates on a flag"
  was false. Flags gate: flagged angles list as `held` and cannot be approved
  until cleared, flagged lines are excluded from evidence, and flagged prose
  falls back to the deterministic body. The table now says so.
- **2026-09-17** — "never used to author question text the operator did not
  write" was false. Corpus-grounded follow-up rounds may be model-authored;
  they are schema-validated and injection-filtered before a source sees them
  (`src/lib/rounds.ts`). The LLM02 mapping now says so.
- **2026-09-17** — "A grep gate asserts this in review" was false; no such gate
  exists in CI or tests. The SQL-injection mapping now names the actual
  controls and says there is no grep gate.
- **2026-09-17** — "Raw submitter-identifying originals never persisted" and
  "submitter text is anonymised before any provider transit" omitted the
  ADR-0012 attachment exception. Both now name it.
- **2026-09-17** — "At-rest storage is ciphertext-only" implied the audit
  endpoint covered every sealed column; it covers four. The table now names the
  covered columns and the gap (#14 extends the audit).
- **2026-09-17** — "generated at provision" folded `OPERATOR_TOKEN` in with the
  key material. It is operator-chosen at boot and never returned; receipts carry
  slot names and booleans only. The secrets section now says so.
- **2026-09-17** — the disclosure section told maintainers to mirror the policy
  "at R8 (#31)" in the target repository; this *is* the target repository, so
  the instruction is gone.
