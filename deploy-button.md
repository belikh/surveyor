# Deploy button

One-click install of one investigation into your own Cloudflare account.

## What it provisions

| Resource | Binding | Purpose |
|---|---|---|
| Worker | — | The installation |
| D1 database | `DB` | Submissions, corpus index, reports, receipts |
| R2 bucket | `CORPUS` | Held-doc raw bytes until drained |
| Queue | `INGEST` | Async corpus ingestion |
| Workflow | `ENGINE` | Staged journalism pipeline |
| Workers AI | `AI` | Keyless baseline tier |
| Cron trigger | — | Scheduled report digests |

## Button flow

1. Click **Deploy to Cloudflare** — the button is a link of the form
   `https://deploy.workers.cloudflare.com/?url=<this-repo-url>`; the
   repository is public, so the URL can be minted for any mirror.
2. Cloudflare provisions every resource above in your account.
3. The install redirects to `/setup` — the first-run wizard.
4. The wizard boots the installation: paste a Cloudflare API token with
   **Workers Scripts: Edit** (the token you deployed with, if you still have
   it) and choose an operator token. The panel sets the three master secrets
   in your own account; no value is logged, stored, or returned.
5. The wizard walks: provider keys (optional) → instrument.
6. The wizard shows the submissions URL and launch pack.

Revoke the pasted Cloudflare token after booting.

## Scoped-token fallback

For private mirrors or restricted orgs, deploy with a token carrying only
the permissions those abstract scopes map to (Workers Scripts, D1, R2,
Queues, Workflows, Secrets Store, Triggers — all Edit). The mapping lives
in `src/lib/scopes.ts`. Revoke it immediately after provisioning.

## Teardown

Use the wizard's teardown screen. It reports exactly what was and was not
wiped; Cloudflare account logs and analytics are outside our control.
