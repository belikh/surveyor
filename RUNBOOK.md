# Surveyor runbook

One investigation per installation. Everything runs in your own Cloudflare
account; this repository is the installer.

## 1. Provision

**Preferred — deploy button.** Click **Deploy to Cloudflare** (see
`deploy-button.md`). Cloudflare creates the Worker, D1, R2, Queue,
Workflow, Workers AI binding, and the cron trigger in your account.

**Fallback — scoped token.** Create an API token with the scopes listed in
`deploy-button.md`, then:

```sh
npm ci && npm run build
# First: replace `database_id = "REPLACE_VIA_PROVISIONING"` in wrangler.toml
# with the D1 id your provisioning step created (the wizard's receipt has
# it). Resource names in wrangler.toml must match the provisioned ones.
npx wrangler deploy
```

Revoke the token straight after; rotate anything it touched.

## 2. First-run setup

Open the installation root. The wizard (Mac OS 9 styled) walks:

1. **Boot** — a fresh install has no key material, so nothing can be written
   until the three master secrets exist. The boot panel sets `SERVER_SECRET`,
   `ENCRYPTION_KEY` and `OPERATOR_TOKEN` in your own account: paste a
   Cloudflare API token that can edit this Worker's secrets (Workers
   Scripts: Edit), your account id and the script name, choose an operator
   token (`Generate` is fine) and save it somewhere safe, then press **Boot
   installation**. The key material is minted inside the Worker and never
   shown; the operator token is your choice and is shown only on that panel.
   Revoke the pasted Cloudflare token afterwards. Alternatively, set all
   three yourself with `npx wrangler secret put SERVER_SECRET` (then
   `ENCRYPTION_KEY` and `OPERATOR_TOKEN`) before opening the wizard.
2. **Worker token** — paste the operator token you chose at boot if the page
   reloaded. It gates every write surface.
3. **Providers** — optional. Add OpenAI-compatible entries (base URL, key,
   model) or leave empty. Empty runs degraded: static question fallbacks,
   Workers AI as the keyless tier, and a visible dashboard warning.
4. **Instrument** — survey title, blurb, and consent copy. Consent copy is
   verbatim on the public survey.

Secrets are written straight to the Cloudflare secret store; they never
pass through a model, a log, or this runbook.

## 3. Corpus

Upload documents through the operator API (`POST /api/corpus`). Text files
parse immediately; PDFs, office files, and images land in held lanes with
their bytes in R2. `POST /api/corpus/drain` runs the model pass — with no
capable provider configured, each file stays held with a reason naming the
capability you need to add. Held bytes live in R2 only for the 24-hour retry
window: a successful drain deletes them immediately, and the scheduled sweep
deletes anything no drain reached and records the receipt in `audit`.

## 4. Running the investigation

- `POST /api/intake` creates a submission (proof-of-work; Turnstile when
  configured). Sources use the public survey at `/survey`.
- `POST /api/engine/angles/propose` queues grounded angles; approve them
  before research lines open (`spend_cap` is enforced).
- `POST /api/reports/:type/approve` then `/publish`. Gated publishes only;
  versioned history; corroboration ticks versus full journalist passes.

## 5. Scheduled digests

The cron trigger (`0 6 * * *`) runs `scheduled()`: first the raw-byte
retention sweep deletes attachment and held-corpus bytes whose retry window
has lapsed — including files no drain ever reached — and writes a receipt to
`audit`; then `evaluateAll` renders reports with a lapsed cadence, crossed
per-N threshold, or full-dynamic change, through the same gated publish path.
Every evaluation writes a receipt (`eval_receipts`) — audit them there.

Full-dynamic is the risky mode: it re-renders on any new evidence and
carries a review banner. Poisoned lines are held before any render.

## 5b. Verifying an installation

Against a live deployment:

```sh
npm run build
node scripts/smoke.mjs https://your-install.workers.dev --token <operator-token>
```

Checks security headers, public status, the survey shell, a proof-of-work
submission round trip, and (with the token) the at-rest ciphertext audit.
Per-check receipts; exits non-zero on any failure.

Against the local runtime (workerd via wrangler, no account needed):

```sh
npm run smoke:runtime
```

## 6. Teardown

The wizard's teardown screen resets local state and reports exactly what
was wiped and what was not. Then delete the Cloudflare resources using the
provisioning receipt: Worker, D1, R2 (empty it first), Queue, Workflow,
secrets. Cloudflare account logs and analytics are outside our control and
are listed as not-wiped.

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
| `CF_OAUTH_CLIENT_SECRET` | Optional | Operator |
| `PUBLIC_BASE_URL` | Required for launch packs (optional otherwise) | Operator |

Never paste a secret value into a transcript, issue, or commit.

## Key rotation and re-sealing

`SERVER_SECRET` and `ENCRYPTION_KEY` are the installation's key material. The
runtime refuses to boot without them — there is no development fallback — so
an installation that ever ran on placeholder key material must rotate before
collecting testimony.

1. Set new `SERVER_SECRET` and `ENCRYPTION_KEY` worker secrets.
2. Re-seal existing rows with the previous pair, operator-gated:

   ```sh
   curl -s -X POST "$BASE/api/audit/reseal" \
     -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
     -d '{"old_server_secret":"<previous>","old_encryption_key":"<previous>"}'
   ```

   The route opens every `v1.` envelope with the supplied old kit, writes it
   back with the current kit, and skips rows that are already current.
3. Confirm `GET /api/audit/ciphertext` reports `ok: true`.

Rows sealed under a key you no longer hold cannot be recovered. `GET
/api/status` reports `provisioned: false` while key material is missing.
