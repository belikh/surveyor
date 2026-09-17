# Surveyor runbook

One investigation per installation. Everything runs in your own Cloudflare
account; this repository is the installer.

## 1. Provision

**Preferred — deploy button.** Click **Deploy to Cloudflare** (see
`deploy-button.md`). Cloudflare creates the Worker, D1, R2, Queue,
Workflow, Workers AI binding, and the cron trigger in your account.

**Fallback — scoped token.** Create an API token with the scopes listed in
`deploy-button.md`, then follow the trial-verified sequence (the same order
`scripts/live-trial-wizard.sh` runs; a fresh account following only these
docs reaches a deployed worker):

```sh
npm ci && npm run build
```

1. **Create the D1 database and put its id in place of the placeholder,
   before deploy.** Wrangler refuses the placeholder id, so this step comes
   first — deploy cannot succeed without it:

   ```sh
   npx wrangler d1 create surveyor-db
   # Copy the id it prints, then replace
   # `database_id = "REPLACE_VIA_PROVISIONING"` in wrangler.toml with it.
   # If the name already exists, resolve the id instead:
   #   npx wrangler d1 info surveyor-db --json
   #   npx wrangler d1 list --json
   ```

   Resource names in wrangler.toml must match the provisioned ones. Keep the
   real id out of upstream commits (the trial backs up wrangler.toml and
   restores the placeholder when done).

2. **Enable R2 on the account, then ensure the corpus bucket exists.**
   Enabling R2 is a dashboard step this runbook cannot take for you: open
   the dashboard, pick R2 in the sidebar and follow the enable flow (it may
   ask for billing details). Then:

   ```sh
   npx wrangler r2 bucket create surveyor-corpus
   npx wrangler r2 bucket list | grep surveyor-corpus
   ```

   Deploying without this step leaves the held-doc store missing; without
   R2 enabled the create fails with an enable-R2 error, not a bucket error.

3. Deploy:

   ```sh
   npx wrangler deploy
   ```

Revoke the token straight after. Re-running provisioning (the wizard's boot
panel or `POST /api/provision`) is non-destructive: it ensures missing
resources and slots and never rewrites a secret that is already set. Do not
rotate the installation's key material as a precaution — rotation is a
deliberate, resealing action (see **Key rotation and re-sealing** below), and
an unnecessary rotation is what orphans sealed rows.

## 2. First-run setup

Open `/setup`. The wizard (Mac OS 9 styled) walks:

1. **Boot** — a fresh install has no key material, so nothing can be written
   until the three master secrets exist. The boot panel sets `SERVER_SECRET`,
   `ENCRYPTION_KEY` and `OPERATOR_TOKEN` in your own account: paste a
   Cloudflare API token that can edit this Worker's secrets (Workers
   Scripts: Edit), your account id and the script name, choose an operator
   token (`Generate` is fine) and save it somewhere safe, then press **Boot
   installation**. `SERVER_SECRET` and `ENCRYPTION_KEY` are minted inside the
   Worker and never shown or returned. The operator token is your choice: the
   panel only echoes what you typed or what the **Generate** button made in
   your own browser, and the installation never returns it — the receipt
   carries slot names and booleans only. Revoke the pasted Cloudflare token
   afterwards. Alternatively, set all three yourself with
   `npx wrangler secret put SERVER_SECRET` (then `ENCRYPTION_KEY` and
   `OPERATOR_TOKEN`) before opening the wizard.
2. **Worker token** — paste the operator token you chose at boot if the page
   reloaded. It gates every write surface.
3. **Providers** — optional. Add OpenAI-compatible entries (base URL, key,
   model) or leave empty. Empty runs degraded: static question fallbacks and
   deterministic (non-model) angles and report prose, with Workers AI covering
   keyless document conversion and OCR in the ingestion lanes, plus a visible
   dashboard warning. Workers AI is not used for chat, angles, rounds or
   report drafting.
4. **Instrument** — survey title, blurb, and consent copy. Consent copy is
   verbatim on the public survey.

Secrets are written straight to the Cloudflare secret store; they never
pass through a model, a log, or this runbook.

## 3. Operator console

Every day-2 action lives in the console at `/console`: paste the operator
token once per browser session (memory only — no cookie, no storage, no URL
entry), and the sections enable. The console covers the whole runbook:

- **Home** — provisioning state, degraded warnings, deployed build commit,
  and counts of outstanding work.
- **Providers** — the provider chain, key entry, reorder, key deletion, and
  the Cloudflare OAuth connection.
- **Corpus** — upload and drain (the old `/corpus` page redirects here).
- **Submissions** — source traffic, threads and structured answers as
  quarantine pseudonyms, consent coverage, attachment lanes, and the
  break-glass reveal with its audit trail.
- **Engine** — propose and review angles (flagged angles are held), open
  research lines, record spend, review, complete or retrigger, and inspect
  the web snapshot behind a citation.
- **Reports** — the five types with gate status, cadence configuration,
  drafts, the legal and recording gates, and confirmed publication.
- **Compliance** — retention windows and sweeps, breach assessment and the
  OAIC statement, notices, the residency map and receipts, and the at-rest
  ciphertext audit.
- **Case file** — the dossier with operator notes and export.
- **Launch** — the launch pack with deliberate rotation, telemetry, the
  scheduler, provisioning, re-sealing after key rotation, and teardown.

The API remains the same surface underneath; the console is a caller, not a
second implementation.

## 4. Corpus

Upload documents through the console's Corpus section (or `POST
/api/corpus` directly). Text files
parse immediately; PDFs, office files, and images land in held lanes with
their bytes in R2. `POST /api/corpus/drain` runs the model pass — with no
capable provider configured, each file stays held with a reason naming the
capability you need to add. Held bytes live in R2 only for their retention
window: a successful drain deletes them immediately, and the scheduled sweep
deletes anything no drain reached and records a deletion receipt. The
window is 24 hours by default and configurable per category with `GET
/api/retention` and `PUT /api/retention` (whole hours, bounded — a request
outside the bounds, or for a category that is retained as the investigation's
record, is refused with a reason).

## 5. Running the investigation

- `POST /api/intake` creates a submission (proof-of-work; Turnstile when
  configured). Sources use the public survey at `/`; the launch-pack short
  link `/s/<slug>` serves the same instrument, so QR codes land in it.
- `POST /api/engine/angles/propose` queues grounded angles; approve them
  before research lines open (`spend_cap` is enforced).
- `POST /api/reports/:type/approve` then `/publish`. Gated publishes only;
  append-only versioned history.

## 6. Scheduled digests

The cron trigger (`0 6 * * *`) runs `scheduled()`: first the raw-byte
retention sweep deletes attachment and held-corpus bytes whose configured
window has lapsed — including files no drain ever reached — and records a
deletion receipt naming every swept category, its counts and whether each
delete was verified. Read the receipts at `GET /api/retention/sweeps`
(newest first, counts only), which also shows the live `overdue` view: raw
rows past their window that still hold bytes. A failed or unconfirmed
delete keeps its raw key, retries on the next sweep, and stays in
`overdue` meanwhile; `POST /api/retention/sweep` runs the sweep on demand
to retry without waiting for the cron. Then `evaluateAll`
renders reports with a lapsed cadence, crossed
per-N threshold, or full-dynamic change, through the same gated publish path.
Every evaluation writes a receipt (`eval_receipts`) — audit them there.

Full-dynamic is the risky mode: it re-renders on any new evidence and
carries a review banner. Poisoned lines are held before any render.

## 6b. Verifying an installation

Against a live deployment:

```sh
npm run build
node scripts/smoke.mjs https://your-install.workers.dev --token <operator-token>
```

Checks security headers, public status, the survey shell, a proof-of-work
submission round trip, and (with the token) the at-rest ciphertext audit.
Per-check receipts; exits non-zero on any failure.

`GET /api/status` names the deployed build (`build.commit`; `build.local`
is true for local/dev builds). After deploying a fix, that one-line check
— not asset archaeology — answers "is the fix deployed?".

The browser PDF path is checked by `test/browser-check.test.ts`, part of
`npm test`: it loads the served survey shell and drives the served PDF.js
tools through a `BrowserDriver` seam (`src/lib/browser.ts`) that extracts and
rasterises a fixture PDF, so it runs in CI with no browser binary. No real
headless browser has been run yet — the seam is where a Playwright/CDP driver
drops in for that live check.

Against the local runtime (workerd via wrangler, no account needed):

```sh
npm run smoke:runtime
```

Two phases, both booting the build in workerd: `wrangler dev` with every
binding audited over HTTP, then a primitives phase that exercises real
queue delivery and retry, Workflow execution and persisted resume, and R2
range and delete behaviour. Every receipt names what it exercised;
failures name the primitive (`queue:*`, `workflow:*`, `r2:*`).

## 6c. Residency and data flows

The installation runs in your Cloudflare account, not in Australia:
Cloudflare offers no Australian storage jurisdiction for D1 or R2 (European
Union, United States and FedRAMP only), and Workers execute on the global
edge. Provisioning configures no jurisdiction restriction, so information
may be stored and processed outside Australia, and Surveyor does not claim
otherwise (ADR-0019). The generated privacy and collection notices state the
same facts for sources.

`GET /api/residency` (operator-only) returns the live map: every recipient
that may handle personal information — Cloudflare's services and each
configured BYOK provider whose key is present — with the regions each may
process in, the source of each region statement (a platform fact, the
committed provider review, or not recorded) and whether the recipient may
process data overseas. The map updates as providers are added or removed.

`POST /api/residency/receipts` records an append-only snapshot of the map;
`GET /api/residency/receipts` lists the receipts and
`GET /api/residency/receipts/<id>/export` downloads the markdown receipt for
the APP 8 record. Provisioning records a receipt automatically, naming
Cloudflare and any provider already configured at that point.

## 7. Teardown

The console's Launch section (or the wizard at `/setup`) resets local state
and reports exactly what was wiped and what was not. Then delete the
Cloudflare resources using the provisioning receipt: Worker, D1, R2 (empty
it first), Queue, Workflow, secrets. Cloudflare account logs and analytics
are outside our control and are listed as not-wiped.

## Secrets reference

| Slot | When | Who sets |
|---|---|---|
| `SERVER_SECRET` | Always | Boot panel (minted in-Worker) or operator |
| `ENCRYPTION_KEY` | Always | Boot panel (minted in-Worker) or operator |
| `OPERATOR_TOKEN` | Always | Operator's choice, entered at boot |
| `GROQ_API_KEY` | Optional | Operator |
| `TOKENROUTER_API_KEY` | Optional | Operator |
| `TURNSTILE_SECRET` | Optional | Operator |
| `TURNSTILE_SITEKEY` | Optional (var, not a secret) | Operator |
| `CF_OAUTH_CLIENT_ID` + endpoints | Optional (vars) | Operator |
| `PUBLIC_BASE_URL` | Required for launch packs (optional otherwise) | Operator |

Never paste a secret value into a transcript, issue, or commit.

## Key rotation and re-sealing

`SERVER_SECRET` and `ENCRYPTION_KEY` are the installation's key material. The
runtime refuses to boot without them — there is no development fallback — so
an installation that ever ran on placeholder key material must rotate before
collecting testimony. This is the only path that changes key material:
re-provisioning and the boot panel never rewrite a slot that is already set.

1. Set new `SERVER_SECRET` and `ENCRYPTION_KEY` worker secrets.
2. Re-seal existing rows with the previous pair, operator-gated:

   ```sh
   curl -s -X POST "$BASE/api/audit/reseal" \
     -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
     -d '{"old_server_secret":"<previous>","old_encryption_key":"<previous>"}'
   ```

   The route covers every sealed column the at-rest audit inspects. For each
   `v1.` envelope it opens with the supplied old kit, seals with the current
   kit, verifies the re-sealed envelope opens back with the current kit,
   then writes it; rows already readable with the current kit are skipped.
   The receipt reports per-column counts plus `skipped` and `failed`;
   envelopes no held kit can open are left untouched and make `ok` false.
3. Confirm `GET /api/audit/ciphertext` reports `ok: true`.

Rows sealed under a key you no longer hold cannot be recovered. `GET
/api/status` reports `provisioned: false` while key material is missing.

## Errata

Corrections made when this document was audited against the code (A7, #8);
each names the claim that changed.

- **2026-09-17** — "Workers AI as the keyless tier" implied the model runs
  everywhere. It serves the ingestion lanes (document conversion and OCR);
  angles, rounds and report prose degrade to deterministic output with no
  Workers AI call. The providers step now says so.
- **2026-09-17** — the boot step said the operator token "is shown only on that
  panel", which read as the installation returning it. No code path returns
  it: the panel echoes the operator's own typed or browser-generated value and
  the receipt carries slot names and booleans only.
- **2026-09-17** — the fallback install path said to "rotate anything it
  touched" after using a scoped token. Rotation is deliberate, requires
  resealing existing rows, and a needless rotation is what orphans sealed
  data; the line now warns against it.
- **2026-09-17** — the retention window was stated as a fixed 24 hours. It is
  per data category with safe defaults and bounds (D1, #44): the default is
  unchanged, the operator configures it through `GET/PUT /api/retention`, and
  the sweep receipt names the windows it enforced.
- **2026-09-17** — "runs in your own Cloudflare account" could be read as
  "in Australia". It is not: Cloudflare offers no Australian storage
  jurisdiction for D1 or R2. Section 5c now states the cross-border posture
  and the data-flow map and receipts (D6, #49).
