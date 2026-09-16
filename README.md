# Surveyor

An open-source, bring-your-own-keys, Cloudflare-native investigation
platform. One installation per investigation, fully self-contained in your
own Cloudflare account.

- **Anonymous submissions** — a survey-framed wizard with proof-of-work and
  optional human-verification. Identifying originals are never stored;
  third-party names live only in an encrypted quarantine.
- **Corpus ingestion** — upload PDFs, office documents, and scans. Text
  parses immediately; everything else waits in held lanes for the model
  pass, gated before it reaches any mirror.
- **Grounded research** — angles proposed against your corpus with cited
  exhibits, capped research lines, and a bounded significance judge.
- **Living reports** — five report types, manual-first publish gates,
  scheduled or per-N updates, append-only history.

## Quick start

```sh
npm ci && npm run build
# Local runtime, no account needed:
npm run smoke:runtime
```

To install for real, see [RUNBOOK.md](RUNBOOK.md) and
[deploy-button.md](deploy-button.md).

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit + integration suite |
| `npm run typecheck` | TypeScript, strict |
| `npm run build` | Worker bundle + smoke helper |
| `npm run smoke:runtime` | Boot workerd locally and smoke it |
| `npm run smoke -- <url> [--token t]` | Smoke a deployed installation |

## Principles

The platform inherits this repository's constitution: source protection
first, secrets never in transcripts, untrusted data treated as data,
library-first, test-verified security, minimal identity surface, bounded
agency, honest threat modelling, corpus purity, Australian English.

## Layout

```
src/lib/      domain logic (vault, pow, ingest, engine, reports, serve)
src/routes/   HTTP surfaces (intake, corpus, engine, reports, launch)
src/frontend/ served shells (setup wizard, survey)
test/         vitest suites, one per domain
scripts/      smoke + local-runtime verification
```
