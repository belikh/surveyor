#!/usr/bin/env bash
# Start the Surveyor worker locally for Niro: build the current checkout, boot
# workerd with local bindings and the throwaway operator token, and wait until
# the app answers.
#
# Bound to 0.0.0.0 on purpose: a listener on 127.0.0.1 only is not reachable
# from Niro's attack container on native Linux Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="$ROOT/niro/harness/run"
PORT="${PORT:-8788}"
TOKEN="test-op-token"
LOG="$RUN_DIR/wrangler.log"
PIDFILE="$RUN_DIR/wrangler.pid"
SECRETS_FILE="$RUN_DIR/secrets.env"

mkdir -p "$RUN_DIR"

# boot() has no development fallback for SERVER_SECRET / ENCRYPTION_KEY, so
# the harness generates real per-run key material and reuses it across
# restarts (the local state it seals must stay readable).
if [ ! -f "$SECRETS_FILE" ]; then
  {
    printf 'SERVER_SECRET=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf 'ENCRYPTION_KEY=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  } >"$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
fi
# shellcheck disable=SC1090
. "$SECRETS_FILE"

# Already running? start is idempotent.
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null || kill -0 -- "-$PID" 2>/dev/null; then
    exit 0
  fi
fi

cd "$ROOT"
[ -d node_modules ] || npm ci
npm run build >/dev/null

SETSID=()
if command -v setsid >/dev/null 2>&1; then SETSID=(setsid); fi
${SETSID[@]+"${SETSID[@]}"} npx wrangler dev --local --ip 0.0.0.0 --port "$PORT" \
  --var "OPERATOR_TOKEN:$TOKEN" \
  --var "SERVER_SECRET:$SERVER_SECRET" \
  --var "ENCRYPTION_KEY:$ENCRYPTION_KEY" >"$LOG" 2>&1 &
echo $! >"$PIDFILE"

for _ in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)" = "200" ]; then
    exit 0
  fi
  sleep 1
done

echo "start: app did not become healthy on http://127.0.0.1:$PORT/; see $LOG" >&2
exit 1
