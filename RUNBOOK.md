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

1. **Worker token** — paste the operator token the provision step showed.
   Store it somewhere safe; it gates every write surface.
2. **Providers** — optional. Add OpenAI-compatible entries (base URL, key,
   model) or leave empty. Empty runs degraded: static question fallbacks,
   Workers AI as the keyless tier, and a visible dashboard warning.
3. **Instrument** — survey title, blurb, and consent copy. Consent copy is
   verbatim on the public survey.

Secrets are written straight to the Cloudflare secret store; they never
pass through a model, a log, or this runbook.

## 3. Corpus

Upload documents through the operator API (`POST /api/corpus`). Text files
parse immediately; PDFs, office files, and images land in held lanes with
their bytes in R2. `POST /api/corpus/drain` runs the model pass — with no
capable provider configured, each file stays held with a reason naming the
capability you need to add.

## 4. Running the investigation

- `POST /api/intake` creates a submission (proof-of-work; Turnstile when
  configured). Sources use the public survey at `/survey`.
- `POST /api/engine/angles/propose` queues grounded angles; approve them
  before research lines open (`spend_cap` is enforced).
- `POST /api/reports/:type/approve` then `/publish`. Gated publishes only;
  versioned history; corroboration ticks versus full journalist passes.

## 5. Scheduled digests

The cron trigger (`0 6 * * *`) runs `scheduled()` → `evaluateAll`. Reports
with a lapsed cadence, crossed per-N threshold, or full-dynamic change
render through the same gated publish path. Every evaluation writes a
receipt (`eval_receipts`) — audit them there.

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
| `SERVER_SECRET` | Always | Provisioning (generated) |
| `ENCRYPTION_KEY` | Always | Provisioning (generated) |
| `OPERATOR_TOKEN` | Always | Provisioning (generated) |
| `GROQ_API_KEY` | Optional | Operator |
| `TOKENROUTER_API_KEY` | Optional | Operator |
| `TURNSTILE_SECRET` | Optional | Operator |
| `TURNSTILE_SITEKEY` | Optional (var, not a secret) | Operator |
| `CF_OAUTH_CLIENT_ID` + endpoints | Optional (vars) | Operator |
| `CF_OAUTH_CLIENT_SECRET` | Optional | Operator |
| `PUBLIC_BASE_URL` | Optional | Operator |

Never paste a secret value into a transcript, issue, or commit.
