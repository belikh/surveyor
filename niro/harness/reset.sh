#!/usr/bin/env bash
# Restore a clean baseline: stop the app, wipe workerd's local state (D1, R2,
# queues, workflows) so the first-run wizard is reachable again, start fresh,
# and re-seed. Idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

"$ROOT/niro/harness/stop.sh"
rm -rf "$ROOT/.wrangler"
"$ROOT/niro/harness/start.sh"
"$ROOT/niro/harness/seed.sh"
