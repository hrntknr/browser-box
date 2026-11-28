#!/usr/bin/env bash
# cdp-events - generic hook template: follow the browser-box CDP event log
# and wake when new events arrive.
#
# To instantiate: copy this file to ~/hooks/scripts/<your-hook>.sh, edit the
# config block below (HOOK_NAME, SUBSCRIPTION_IDS), register it with the
# hooks tool (add -> dry_run -> enable). The cursor lives in
# ~/hooks/state/<HOOK_NAME>.cursor and is not advanced on dry runs.
#
# The control API is read over plain HTTP via the sshmitm SSH forward:
# bb-tunnel.sh (in .muse/) must be running on the machine running the
# hook. BB_API_URL overrides where the API is read from.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

# ---- config (edit when instantiating) ----
HOOK_NAME="cdp-events"
SUBSCRIPTION_IDS="" # comma-separated subscription ids; empty = any subscription
API="${BB_API_URL:-http://localhost:16082}"
# ------------------------------------------

STATE_DIR="$HOME/hooks/state"
CURSOR_FILE="$STATE_DIR/$HOOK_NAME.cursor"
mkdir -p "$STATE_DIR"

DRY=0
[ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ] && DRY=1

fetch_events() {
  curl -s --max-time 20 "$API/bb/events?since=$1&limit=200" || true
}

# First run: baseline the cursor at the current end of the log and stay
# silent, so historical events do not fire the worker.
if [ ! -f "$CURSOR_FILE" ]; then
  resp=$(fetch_events 0)
  next=$(printf '%s' "$resp" | jq -r '.next // empty' 2>/dev/null || true)
  if [ -z "$next" ]; then
    log "cdp-events: event log unreachable during init" '{}'
    silent "event log unreachable" '{}'
  fi
  if [ "$DRY" = "0" ]; then printf '%s' "$next" > "$CURSOR_FILE"; fi
  log "cdp-events: cursor initialized" "{\"next\": $next, \"dry\": $DRY}"
  silent "cursor initialized at $next" '{}'
fi

cursor=$(cat "$CURSOR_FILE")
resp=$(fetch_events "$cursor")
next=$(printf '%s' "$resp" | jq -r '.next // empty' 2>/dev/null || true)
if [ -z "$next" ]; then
  log "cdp-events: event log unreachable" '{}'
  silent "event log unreachable" '{}'
fi

# The event log is in-memory on the server: after a server restart seq
# starts over below our cursor. Reset and re-read from the beginning.
if [ "$next" -lt "$cursor" ]; then
  log "cdp-events: event log reset detected" "{\"cursor\": $cursor, \"next\": $next}"
  cursor=0
  resp=$(fetch_events 0)
  next=$(printf '%s' "$resp" | jq -r '.next // empty' 2>/dev/null || true)
  if [ -z "$next" ]; then
    log "cdp-events: event log unreachable" '{}'
    silent "event log unreachable" '{}'
  fi
fi

events=$(printf '%s' "$resp" | jq -c --arg ids "$SUBSCRIPTION_IDS" '
  .events
  | if $ids == "" then .
    else map(select(.subscriptionId as $s | ($ids | split(",") | index($s) != null)))
    end')
count=$(printf '%s' "$events" | jq 'length')

if [ "$DRY" = "0" ]; then printf '%s' "$next" > "$CURSOR_FILE"; fi

if [ "$count" -gt 0 ]; then
  payload=$(printf '%s' "$events" | jq -c '{count: length, events: .[0:20]}')
  log "cdp-events: waking" "$payload"
  wake "cdp events: $count new" "$payload"
fi
silent "no new events" '{}'
