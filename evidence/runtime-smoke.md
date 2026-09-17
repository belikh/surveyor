# Runtime smoke evidence — workerd (wrangler dev + miniflare)

Run 2026-09-17 on the A10 build (branch `campaign/a`), no Cloudflare
account. Two phases, both booting workerd from the same `dist/worker.js`:

1. `wrangler dev --local` with every binding, audited over HTTP by
   `scripts/smoke.mjs`.
2. `scripts/runtime-primitives.mjs`, which boots the build through
   miniflare (the engine under `wrangler dev`) and drives the Workers
   primitives directly. Failures name the primitive: `queue:*`, `r2:*`,
   `workflow:*`.

Command: `npm run smoke:runtime`. Environment: wrangler 4.133.0
(miniflare 5.20260916.0-alpha). `AI` reports "not supported" locally, so
the queue drain lands as `held` with a reason — delivery and ack are what
this smoke proves, not OCR.

```
[PASS] header:content-security-policy — default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 's
[PASS] header:x-content-type-options — nosniff
[PASS] header:referrer-policy — no-referrer
[PASS] header:x-frame-options — DENY
[PASS] status:degraded — degraded=true warning=present
[PASS] survey:shell — HTTP 200
[PASS] intake:pow-create — HTTP 201
[PASS] operator:corpus-list — HTTP 200
[PASS] operator:telemetry — 0 turn(s) recorded
[PASS] operator:ciphertext-only — messages=0 corpus=1 entities=0

10 passed, 0 failed, 0 skipped
[PASS] queue:delivery — consumer drained and acked (drain:held-ocr -> held)
[PASS] queue:retry — 3 retries then dropped (Dropped message "…" on queue "surveyor-ingest" after 4 failed attempts!)
[PASS] r2:range-read — offset 1 length 2 returned [2,3]
[PASS] r2:delete — object unreadable after delete; repeat delete is a no-op
[PASS] workflow:create-run — EngineWorkflow instance … ran its steps to complete
[PASS] workflow:resume — instance … still complete after workerd restart; no step replayed

6 passed, 0 failed, 0 skipped
```

## What each primitive check runs

- **`queue:delivery`** — a held upload (`POST /api/corpus`) enqueues on
  `INGEST`; the configured consumer drains it and acks. The receipt is a
  `drain:<lane>` telemetry row, not just the producer call.
- **`queue:retry`** — a message the consumer can never drain (missing
  `doc_id`) is delivered, retried (`maxRetries: 3`, mirroring
  `wrangler.toml`), and dropped after 4 failed attempts. Both the retry
  count and the drop are read from the runtime's own queue logs.
- **`r2:range-read`** — `R2Bucket.get(key, { range })` returns exactly the
  requested slice (offset 1, length 2 of `[1,2,3,4,5]` → `[2,3]`).
- **`r2:delete`** — `R2Bucket.delete` removes the object, a repeat delete
  is a no-op, and a missing key reads back `null`.
- **`workflow:create-run`** — `ENGINE.create` from
  `POST /api/engine/lines` runs `EngineWorkflow`'s steps to `complete`,
  verified through the runtime's local workflow introspection API and the
  workflow telemetry turn.
- **`workflow:resume`** — the workerd runtime is disposed and rebooted
  against the same persistence; the completed instance is still
  `complete` and its steps did not replay (workflow telemetry turn count
  unchanged).

This phase is also what exposed the Workflow entry extending an inert
base class: workerd addresses `EngineWorkflow` as the workflow's named
entrypoint, and an instance refused to run until the class extended the
runtime's `WorkflowEntrypoint` from `cloudflare:workers` (A10, #11).

Reproduce: `npm ci && npm run build && npm run smoke:runtime`. The
primitives phase resolves the miniflare bundled with the npx-installed
wrangler, so package.json gains no new dependency.
