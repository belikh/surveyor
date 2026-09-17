# Surveyor harness

Niro-started runtime operations for this checkout. All scripts `cd` to the
repository root and keep their runtime state under `harness/run/`.

## Contract

| Operation | Entry point | Behaviour |
| --- | --- | --- |
| start | `start.sh` | `npm ci` when `node_modules` is missing, `npm run build`, then `wrangler dev --local` on `0.0.0.0:8788` with `OPERATOR_TOKEN=test-op-token` and per-run generated `SERVER_SECRET`/`ENCRYPTION_KEY` (kept in `run/secrets.env`); waits for HTTP 200 on `/`; writes `run/wrangler.pid` and `run/wrangler.log` |
| stop | `stop.sh` | Stops the recorded process group and removes the PID file |
| seed | `seed.sh` | Creates two original submissions through the public intake API (challenge → proof-of-work → create → steps) and writes `../credentials.yaml` and `../fixtures.yaml` |
| reset | `reset.sh` | `stop.sh`, removes `.wrangler/` local state, `start.sh`, `seed.sh` |

The target URL for `start_pentest` is `http://127.0.0.1:8788` (authorized in
`../scope.yaml`). The app binds to `0.0.0.0` so Niro's attack container can
reach it through the loopback mapping; binding to `127.0.0.1` only is not
reachable on native Linux Docker.

## Notes

- The operator token is the fixed throwaway `test-op-token`, the same value
  `scripts/runtime-smoke.sh` uses. This profile never touches a deployed
  installation, so no real secret is involved.
- `seed.sh` is additive by design: each invocation creates fresh submissions
  and rewrites the generated credential catalog to match.
- Local state lives in `.wrangler/state/` (workerd's D1, R2, queues,
  workflows). `reset.sh` is the supported way to get back to a first-run
  pristine app, including the setup wizard.
