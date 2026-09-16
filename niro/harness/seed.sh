#!/usr/bin/env bash
# Create the deterministic baseline and regenerate the credential catalog and
# fixture references Niro consumes. Requires the app to be running (start.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8788}"

ready=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "seed: app is not reachable on http://127.0.0.1:$PORT/; run start.sh first" >&2
  exit 1
fi

node "$ROOT/niro/harness/seed.mjs" \
  --base "http://127.0.0.1:$PORT" \
  --config-dir "$ROOT/niro"
