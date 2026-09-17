#!/usr/bin/env bash
# Local-runtime verification in two phases, no Cloudflare account needed:
#
#   1. `wrangler dev` boots the built Worker with every binding and
#      scripts/smoke.mjs audits the HTTP surface.
#   2. scripts/runtime-primitives.mjs boots the same build in workerd and
#      exercises the runtime primitives directly: queue delivery and retry,
#      Workflow execution and persisted resume, and R2 range and delete
#      behaviour. Failures name the primitive involved.
#
# Exits non-zero if any check fails.
set -euo pipefail

PORT="${PORT:-8788}"
TOKEN="test-op-token"
# Provisioned bindings for the test runtime: boot() has no development
# fallback, so the smoke supplies its own throwaway key material.
SERVER_SECRET="smoke-server-secret"
ENCRYPTION_KEY="$(printf 'ab%.0s' $(seq 1 32))"
LOG="$(mktemp)"
cd "$(dirname "$0")/.."

npm run build >/dev/null

# wrangler dev spawns children (npx -> wrangler -> workerd). Killing only the
# npx wrapper leaves workerd bound to the port after this script exits, which
# collides with anything that boots the app next — including Niro's harness.
# Run wrangler in its own process group (setsid, where available) and tear the
# whole group down.
SETSID=()
if command -v setsid >/dev/null 2>&1; then SETSID=(setsid); fi
${SETSID[@]+"${SETSID[@]}"} npx wrangler dev --local --port "$PORT" --ip 127.0.0.1 \
  --var "OPERATOR_TOKEN:$TOKEN" \
  --var "SERVER_SECRET:$SERVER_SECRET" \
  --var "ENCRYPTION_KEY:$ENCRYPTION_KEY" >"$LOG" 2>&1 &
WRANGLER_PGID=$!
cleanup() {
  kill -TERM -- "-$WRANGLER_PGID" 2>/dev/null || true
  kill -TERM "$WRANGLER_PGID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 -- "-$WRANGLER_PGID" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -- "-$WRANGLER_PGID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

for _ in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)" = "200" ]; then
    break
  fi
  sleep 1
done

node scripts/smoke.mjs "http://127.0.0.1:$PORT" --token "$TOKEN"

# Phase 2: miniflare ships inside wrangler, which npx has installed by now.
# Resolve its entry from the wrangler binary on the npm-exec PATH so the
# primitives script needs no new dependency in package.json.
MINIFLARE_ENTRY="$(
  npm_config_loglevel=error npm exec --yes --package=wrangler -- bash -c '
    bin="$(readlink -f "$(command -v wrangler)")"
    printf "%s/miniflare/dist/src/index.js" "$(dirname "$(dirname "$(dirname "$bin")")")"
  '
)"
node scripts/runtime-primitives.mjs "$MINIFLARE_ENTRY"
