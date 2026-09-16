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

npx wrangler dev --local --port "$PORT" --ip 127.0.0.1 \
  --var "OPERATOR_TOKEN:$TOKEN" >"$LOG" 2>&1 &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" 2>/dev/null || true; rm -f "$LOG"' EXIT

for _ in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)" = "200" ]; then
    break
  fi
  sleep 1
done

node scripts/smoke.mjs "http://127.0.0.1:$PORT" --token "$TOKEN"
