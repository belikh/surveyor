#!/usr/bin/env bash
# Local-runtime verification: boot the worker in workerd (miniflare) with
# every binding, run the smoke script against it, and report receipts.
# No Cloudflare account required. Exits non-zero if any check fails.
set -euo pipefail

PORT="${PORT:-8788}"
TOKEN="test-op-token"
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
  --var "OPERATOR_TOKEN:$TOKEN" >"$LOG" 2>&1 &
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
