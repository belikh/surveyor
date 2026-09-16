# Security Policy — Surveyor (investigation platform)

**Status**: R1 deliverable (remediation #24). Companion to `THREAT-MODEL.md` and
constitution Principle II (secrets never in transcripts) and V (test-verified
security). Australian English.

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

- Email the maintainers (address to be added at the R8 open-source release) with
  a description, reproduction steps, and impact.
- If the project is on GitHub, use **Security → Report a vulnerability** (private
  advisory) instead of a public issue.
- We aim to acknowledge within 7 days and to coordinate disclosure after a fix.
- Never include a real secret, a live submission, or a source's data in a report;
  use synthetic fixtures.

This disclosure process must be mirrored in the target repository at R8 (#31).

## Supported versions

The platform ships as one installation per investigation. Security fixes land on
`main` and are deployed by operators through their own redeploy path (see
`README.md`). There is no hosted version to patch on the operator's behalf.

## Security properties and how they are enforced

| Property | Enforcement |
|---|---|
| Raw submitter-identifying originals never persisted | Anonymise-then-store in request memory; only AES-256-GCM envelopes written |
| Secrets never in transcripts, rows, logs, or receipts | Secret store only; slot names/booleans elsewhere; constant-time operator compare |
| Names never in the mirror or agent context | Name-leak gate after extraction, before any mirror/embedding/prompt write |
| Untrusted content is data, never instructions | Delimited framing, read-only tools, Zod at every boundary, output policing, `textContent`-only rendering |
| Mirror purity | Mirror scan test proves zero entity names present |
| Flags never auto-action | Flags are admin-only hints; no code path hides, deletes, or gates on a flag |
| At-rest storage is ciphertext-only | `/api/audit/ciphertext` reports envelope counts and malformed count without decrypting |
| Corpus custody | Constitution Principle XI ledger; raw held bytes in the operator's private R2 with bounded retention (retention cap pending R6) |

## OWASP LLM Top 10 mapping

- **LLM01 Prompt injection** — everything a submitter, document, or model
  produces is data. No side-effecting tools; read-only corpus tools only;
  `maxSteps` and length caps; output schema validation and injection-marker
  policing; fenced, never auto-published. Tests: injection fixture suite asserts
  zero rule-following and no system-prompt leakage.
- **LLM02 Insecure output handling** — model output is never rendered as HTML
  (`textContent` only), never executed, never used to author question text the
  operator did not write, and never published without passing gates.
- **LLM06 Sensitive information disclosure** — submitter text is anonymised
  before any provider transit; the corpus path sends gated text only; prompts
  never contain quarantined names; secrets never enter a prompt.
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
- **SQL injection** — parameterised D1 statements only; no string-interpolated
  SQL. A grep gate asserts this in review.
- **SSRF** — custom provider base URLs are validated at save time; the
  provisioner calls only Cloudflare API endpoints; fetched targets are the
  configured providers.

## Secrets and tokens

- `SERVER_SECRET`, `ENCRYPTION_KEY`, `OPERATOR_TOKEN` — generated at provision;
  receipts carry names and booleans only.
- `GROQ_API_KEY`, `TOKENROUTER_API_KEY`, `TURNSTILE_SECRET` — operator-supplied
  through the wizard; written to the secret store; never persisted to D1.
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
ciphertext-only audit and header policy.
