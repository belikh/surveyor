# Surveyor

An open-source, bring-your-own-keys, Cloudflare-native investigation
platform. One installation per investigation, fully self-contained in your
own Cloudflare account — but not in Australia: Cloudflare offers no
Australian storage jurisdiction for D1 or R2 (European Union, United States
and FedRAMP only), so information may be stored and processed outside
Australia. The installation's data-flow map (`GET /api/residency`) names
every recipient, and recorded receipts document the disclosure honestly
(ADR-0019).

- **Anonymous submissions** — a survey at the installation root (the
  launch-pack short link `/s/<slug>` serves the same instrument) with
  proof-of-work and
  optional human-verification. Identifying originals are never stored, with
  one documented exception: an uploaded attachment is held raw in private R2
  only until its ingestion lane drains (never past the retry window plus the
  scheduled sweep), then reduced to gated testimony and deleted (ADR-0012).
  Third-party names live only in an encrypted quarantine.
- **Corpus ingestion** — upload PDFs, office documents, and scans. Text
  parses immediately; everything else waits in held lanes for the model
  pass, gated before it reaches any mirror. Native parsing accuracy is
  [measured and published](evidence/ocr-accuracy/); the model-pass lanes on
  scans remain a recorded gap there, not a claim.
- **Operator console** — a browser console at `/console` for every day-2
  action: providers and keys, corpus upload and drain, submissions and
  consent, angle review, research lines, report gates and publication,
  retention, breach, notices, residency, launch pack and teardown. The
  operator token lives in page memory only; controls are inert without it.
- **Grounded research** — angles proposed against your corpus with cited
  exhibits, capped research lines, and a bounded significance judge.
- **Living reports** — five report types, manual-first publish gates,
  scheduled or per-N updates, append-only history. Drafts annotate uncited
  claims and publish strips them unless the operator explicitly approves
  them; that enforcement is
  [measured and published](evidence/report-quality/), with live-model prose
  quality a recorded gap there, not a claim.

## Quick start

```sh
npm ci && npm run build
# Local runtime, no account needed:
npm run smoke:runtime
```

To install for real, see [RUNBOOK.md](RUNBOOK.md) and
[deploy-button.md](deploy-button.md). To exercise the live provisioner and
consent flow against a real account, run the repeatable live-trial wizard
(`scripts/live-trial-wizard.sh`): it is syntax-checked, holds no
trial-specific values, and walks deploy → boot → consent → provision →
smoke → teardown end to end.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit + integration suite |
| `npm run typecheck` | TypeScript, strict |
| `npm run build` | Worker bundle + smoke helper |
| `npm run smoke:runtime` | Boot workerd locally: HTTP surface + queue, Workflow and R2 primitives |
| `npm run console:check` | Boot workerd locally and drive the console with headless Chromium (Playwright), one receipt per step |
| `npm run smoke -- <url> [--token t]` | Smoke a deployed installation |

## Security testing (Niro)

`.github/workflows/niro-find.yml` runs a manual, find-only penetration test with
[Niro Community Edition](https://github.com/apxlabs-ai/niro), in checkout mode:
Niro builds a harness and starts the app on the runner itself. The committed
`niro/` profile owns that lifecycle — `niro/harness/start.sh` boots the worker
on the runner, `niro/harness/seed.sh` creates the test baseline and generates
the credentials Niro consumes, and `niro/scope.yaml` authorizes only the
loopback listener. It never creates branches or pull requests, runs only when
dispatched by hand, and publishes the penetration-test report and knowledge
bundle as 30-day artifacts. Completed reports are promoted to
[published evidence](evidence/niro/) with their date, scope and provenance; the
latest is the [2026-09-16 run](evidence/niro/2026-09-16-penetration-test.md).

DeepSeek is the default model, reached through the Copilot agent's
OpenAI-compatible BYOK provider. Configure (and later rotate) the credentials
with the wizard:

```sh
scripts/setup-deepseek-niro.sh
```

Then dispatch:

```sh
gh workflow run niro-find.yml -f agent=copilot
```

## Principles

The platform inherits this repository's constitution: source protection
first, secrets never in transcripts, untrusted data treated as data,
library-first, test-verified security, minimal identity surface, bounded
agency, honest threat modelling, corpus purity, Australian English.

## Layout

```
src/lib/      domain logic (vault, pow, ingest, engine, reports, serve)
src/routes/   HTTP surfaces (intake, corpus, engine, reports, launch)
src/frontend/ served shells (setup wizard, survey, operator console)
test/         vitest suites, one per domain
scripts/      smoke + local-runtime verification
```

## Errata

Corrections made when this document was audited against the code (A7, #8);
each names the claim that changed.

- **2026-09-17** — "Identifying originals are never stored" was stated without
  qualification. Submitter attachments are a controlled Principle I exception
  (ADR-0012): the raw file is held in private R2 until its lane drains, then
  deleted, with the scheduled sweep enforcing the window when no drain comes.
  The quick-start bullets now carry that exception.
- **2026-09-17** — "fully self-contained in your own Cloudflare account" could
  be read as "in Australia". It is not: Cloudflare offers no Australian
  storage jurisdiction for D1 or R2. The introduction now says so and names
  the data-flow map and receipts (D6, #49).
