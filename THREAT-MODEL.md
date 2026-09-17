# Threat Model — Surveyor (investigation platform)

**Status**: R1 deliverable (remediation #24). Companion to `SECURITY.md` and
constitution Principle VIII (Honest Threat Modelling). Australian English.

## 1. Scope and assets

Surveyor is one installation per investigation (ADR-0001), running entirely in
the operator's own Cloudflare account. Assets, in priority order:

| Asset | Custody | Why it matters |
|---|---|---|
| Submitter identity | Source | A leak can get a source fired, prosecuted, or harmed |
| Submission content | Source | The testimony itself |
| Quarantined third-party names | Operator | Unmasking names exposes non-consenting people |
| Corpus raw bytes | Operator | Sensitive internal documents; may name people |
| Provider keys / secrets | Operator | Fraud, cost, and access to the operator's account |
| Published reports | Public | Defamation and poisoning surface |
| Operator identity | Operator | The whole point is that publishing exposes no one |

## 2. Trust boundaries

```text
Source browser ──TLS──▶ Cloudflare edge ──▶ Worker (surveyor)
                                              │
              operator browser ──TLS──▶ Worker ├─▶ D1   (sealed rows + FTS mirror)
                                              ├─▶ R2   (raw corpus bytes, held lanes)
                                              ├─▶ Queue (INGEST) ─▶ drain
                                              └─▶ Workflow (ENGINE) ─▶ research lines
                                              │
                        provider registry ────┴──▶ third-party LLM APIs (BYOK)
                        workers AI binding ───────▶ Cloudflare Workers AI
```

Boundaries that carry risk: **source→Worker** (untrusted content and injection),
**Worker→provider** (anonymised text and gated corpus excerpts leave the
account), **Worker→R2** (raw bytes at rest), **Cloudflare→anyone** (the platform
trusts Cloudflare for TLS and storage), and **operator browser→Worker** (token
auth).

## 3. Threats

### T1 — Submission deanonymisation via storage leak

A database/bucket leak must reveal nothing identifying.

- **Mitigations**: free text is pre-scrubbed and anonymised in request memory
  before storage; only AES-256-GCM envelopes are written; third-party names live
  only in the encrypted quarantine; raw submitter originals are never persisted;
  access codes are stored as HMAC only; no IP/UA/referrer logged.
- **Residual risk**: sealed text is decryptable by anyone holding
  `ENCRYPTION_KEY`; a compromised Worker/runtime can decrypt in memory. Metadata
  (submission count, timestamps, lengths) is not encrypted. Stylometry could
  re-identify a submitter from their own text given an external writing sample.

### T2 — Prompt injection from submissions

A submitter (or corpus document) attempts to steer the LLM.

- **Mitigations**: everything is data, never instructions; untrusted framing with
  delimiters; read-only tools only; `maxSteps`/length caps; Zod validation at
  every boundary; output policing rejects injection markers and tool-vocabulary
  leakage; `textContent`-only rendering. No write tool exists at any tier.
- **Residual risk**: injection cannot be solved, only contained; a novel
  jailbreak may still influence *question wording*, which is why all model output
  stays fenced and never publishes directly (ADR-0003, FR-023/FR-024).

### T3 — Raw corpus bytes at rest (R2 custody)

**Held-lane corpus documents sit unencrypted and un-gated in the operator's R2
bucket** until drained.

- **Why**: parsing must be asynchronous (128 MB isolate, request CPU limits), and
  the bytes are the operator's own material (constitution XI).
- **Implications for Principles I/IX**: Principle I's "raw never stored" applies
  to *submitter originals* and is unchanged. Principle IX's "no names cross to
  the mirror" is preserved because the gate runs **after extraction and before**
  any mirror/embedding/prompt write. R2 holds bytes *before* the gate, but they
  are never agent-visible.
- **Mitigating controls**: the bucket is private and bound to one installation in
  the operator's account; the key is a random doc id; no application logging of
  file contents; raw bytes are deleted on successful drain; the scheduled
  raw-byte sweep (`src/lib/retention.ts`, A3) deletes anything no drain reached
  once the 24 h retry window lapses and records a deletion receipt in `audit`; a
  lifecycle rule must abort incomplete multipart uploads; failed files stay held
  with a reason and are operator-deletable.
- **Residual risk**: the window between upload and drain exposes raw bytes to
  anyone with account-level R2 access, and to Cloudflare. Bytes live at most one
  retry window past the last upload or failed drain; deletion is automatic and
  receipted, not operator-dependent.

### T4 — Secret exfiltration

- **Mitigations**: secret values live only in the Cloudflare secret store,
  written by wizard code with no D1/log/receipt/model in the path. Key entry
  (R2) uses a transient OAuth-consented Cloudflare token: exchanged at the
  callback, returned to the wizard in the **URL fragment** (never sent to the
  server), forwarded with the key, and discarded — neither the token nor the
  provider key is persisted, logged, or telemetered. The platform stores slot
  names and boolean presence only; `OPERATOR_TOKEN` compare is constant-time;
  deploys never delete or echo secrets.
- **Residual risk**: a fully compromised Worker can read bound secrets; the
  operator's Cloudflare account compromise is out of scope. The transient OAuth
  token is briefly visible in the browser URL fragment (history) before it is
  cleared; it is short-lived and scoped. The OAuth client-credential model for a
  self-hosted open-source install (shared secret vs PKCE) is an open question
  (ADR-0008).

### T5 — Hostile uploads (parser exploits, decompression bombs)

- **Mitigations**: size cap before decode; lane classification; unsupported types
  rejected; parsing runs off the request path with bounded CPU/wall time; failed
  parse keeps the file held rather than crashing; no server-side render of
  untrusted formats.
- **Residual risk**: a memory-safety bug in a parse library runs inside the
  isolate; the blast radius is one request, and the output still has to pass the
  gate.

### T6 — Corpus poisoning / adversarial evidence

- **Mitigations**: flag-and-gate — suspicious lines are held from every report
  pending operator review; provenance always marked; findings fenced; nothing
  poisoned auto-publishes. Full-dynamic reports carry a danger marking and a
  review banner.
- **Residual risk**: the significance judge and angle proposer are themselves
  LLM-exposed and are treated as untrusted; a subtle poisoning that does not trip
  the markers could still reach a draft (never a publish without the operator).

### T7 — Queue/Workflow failure, DLQ, and retries

- **Mitigations**: uploads are durable in R2 + D1 before enqueue, so nothing
  user-visible depends on the queue succeeding. The consumer acks on success and
  retries on throw (`max_retries = 3`, batch ≤5). Drained docs delete their R2
  object; failed docs keep it and record a reason. Steps are idempotent by doc id
  and by line id; the topics ledger is the re-bill backstop.
- **Residual risk**: **there is no dead-letter queue configured** — after
  `max_retries` a message is dropped; the file simply remains held and must be
  re-drained manually. Poison messages could retry up to the cap. This is
  recorded honestly rather than hidden (R6 tracks hardening).

### T8 — Auto-publish poisoning / defamation

- **Mitigations**: manual approval is the default; automatic gates are opt-in;
  gate config is stored with the report, never accepted at publish; published
  history is append-only; held lines are excluded.
- **Residual risk**: an operator who enables full-dynamic on a poisoned corpus
  can publish defamatory material. Legal/defamation gates and a lawyer review
  insertion point remain **fog** (unresolved, out of scope for now).

### T9 — Launch-pack identity leak

- **Mitigations**: pack is public-safe by construction; bare-URL QR only (no
  query/fragment/tracking markers); structural audit rejects supplied forbidden
  terms and banned claim phrases; the slug carries no operator identity.
- **Residual risk**: an unlisted identifying phrase the operator did not supply
  can still pass the audit.

### T10 — Teardown residue

- **Mitigations**: teardown empties R2 before deleting the bucket, deletes in a
  documented order, and reports a per-resource wipe/not-wiped receipt
  (`teardownStack`).
- **Residual risk**: Cloudflare account logs, analytics, backups, the cloned Git
  repo, and Workers Builds history are **not wiped** and are named as such. The
  provision receipt must exist at runtime for teardown to have anything to work
  from (R3 — currently test-only).

### T11 — Submitter attachment raw-bytes window

A submitter-attached document transits the Worker into a private R2 key and
stays there, **unencrypted**, until the lane extracts its text (success deletes
it; failure keeps it for a bounded 24 h retry). This is the user-approved
Principle I exception (ADR-0012; the Complexity Tracking record is pre-split
and not carried into this repository).

- **Mitigations**: private bucket bound to one installation; the key is a
  random id; the raw is never sent to a text prompt or logged; the gate runs on
  extracted text before any storage; extracted text is testimony-only (never
  the corpus mirror); the raw is deleted on success and after the retry window.
- **Residual risk**: Cloudflare and anyone with account-level R2 access can
  read the bytes during the window; a file that repeatedly fails sits for one
  more retry window after the last failed drain, then the scheduled sweep
  deletes it and receipts the deletion. The specification deliberately does not
  claim an at-rest seal.

## 4. Documented limits (honest, not aspirational)

- The anonymisation pass and gated excerpts leave the account to a third-party
  provider over TLS (BYOK); Cloudflare terminates TLS and hosts D1/R2/Queues.
- Detection flags are probabilistic and never auto-actioned.
- The FTS mirror holds gated text in plaintext for search.
- Held corpus bytes are unencrypted in R2 (T3) with a bounded-retention
  requirement that is not yet implemented.
- `workers.dev` may be blocked in some jurisdictions; custom domains are out of
  scope in v1 (anonymity trade-off documented).
- Stylometry is a signal, not proof, and is admin-only.
- Teardown cannot purge Cloudflare-side backups/logs/analytics.

## 5. Open unknowns (need a live trial)

- OCR accuracy on poor scans (bake-off) and the PDF page-to-image render step.
- Exact minimal scoped-token permission set and deploy-button D1-migration
  reliability.
- Workers AI per-request image/token ceiling.
- Per-installation cost ceilings when BYOK keys exhaust or rate-limit.
