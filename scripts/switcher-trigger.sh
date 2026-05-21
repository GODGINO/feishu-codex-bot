#!/bin/bash
# Manually trigger a sigma-switcher account switch via the running daemon.
# Usage: bash scripts/switcher-trigger.sh <email> [--watch]
#   --watch   tail the switcher log until the switch completes (ctrl-c to stop)

set -e

EMAIL="${1:-}"
WATCH="${2:-}"
PORT="${SWITCHER_HTTP_PORT:-17222}"
LOG="$HOME/.sigma-switcher/logs/switcher.log"

if [ -z "$EMAIL" ]; then
  echo "usage: $0 <email> [--watch]" >&2
  exit 2
fi

if ! curl -sf "http://127.0.0.1:$PORT/status" >/dev/null; then
  echo "error: switcher daemon not reachable on :$PORT — run 'bash scripts/bot.sh restart' first" >&2
  exit 1
fi

echo "→ triggering switch to $EMAIL"
resp=$(curl -sS -X POST "http://127.0.0.1:$PORT/trigger_switch" \
  -H 'Content-Type: application/json' \
  --data-raw "$(printf '{"email":"%s"}' "$EMAIL")")
echo "  daemon response: $resp"

if ! echo "$resp" | grep -q '"ok": *true'; then
  echo "error: trigger rejected" >&2
  exit 1
fi

if [ "$WATCH" = "--watch" ]; then
  echo "→ tailing $LOG (ctrl-c to stop; switch continues in daemon)"
  tail -n 0 -f "$LOG"
fi
