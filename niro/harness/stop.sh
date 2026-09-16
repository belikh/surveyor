#!/usr/bin/env bash
# Stop the Surveyor worker started by start.sh. Idempotent: exits 0 when
# nothing is running.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="$ROOT/niro/harness/run"
PIDFILE="$RUN_DIR/wrangler.pid"

if [ ! -f "$PIDFILE" ]; then
  exit 0
fi

PID="$(cat "$PIDFILE")"
kill -TERM -- "-$PID" 2>/dev/null || true
kill -TERM "$PID" 2>/dev/null || true

for _ in $(seq 1 20); do
  if ! kill -0 "$PID" 2>/dev/null && ! kill -0 -- "-$PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

kill -KILL -- "-$PID" 2>/dev/null || true
kill -KILL "$PID" 2>/dev/null || true
rm -f "$PIDFILE"
