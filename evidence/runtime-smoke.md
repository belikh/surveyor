# Runtime smoke evidence — workerd (wrangler dev --local)

Run 2026-09-16 on the build at commit `6adec7c`, no Cloudflare account.

Bindings resolved: `ENGINE` (Workflow), `INGEST` (Queue), `DB` (D1),
`CORPUS` (R2) — all local; `AI` reports "not supported" locally, as
expected. Command: `npm run smoke:runtime`.

```
[PASS] header:content-security-policy — default-src 'none'; script-src 'self'; ...
[PASS] header:x-content-type-options — nosniff
[PASS] header:referrer-policy — no-referrer
[PASS] header:x-frame-options — DENY
[PASS] status:degraded — degraded=true warning=present
[PASS] survey:shell — HTTP 200
[PASS] intake:pow-create — HTTP 200
[PASS] operator:corpus-list — HTTP 200
[PASS] operator:telemetry — 0 turn(s) recorded
[PASS] operator:ciphertext-only — messages=0 corpus=0 entities=0

10 passed, 0 failed, 0 skipped
```

Reproduce: `npm ci && npm run build && npm run smoke:runtime`.
