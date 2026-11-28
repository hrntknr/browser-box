#!/usr/bin/env bash
# cdp-events - generic hook template: follow the browser-box CDP event log
# and wake when new events arrive.
#
# To instantiate: copy this file to ~/hooks/scripts/<your-hook>.sh, edit the
# config block below (HOOK_NAME, SUBSCRIPTION_IDS), register it with the
# hooks tool (add -> dry_run -> enable). The cursor lives in
# ~/hooks/state/<HOOK_NAME>.cursor and is not advanced on dry runs.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

# ---- config (edit when instantiating) ----
HOOK_NAME="cdp-events"
SUBSCRIPTION_IDS="" # comma-separated subscription ids; empty = any subscription
KUBECTL="${BB_KUBECTL:-$HOME/workspace/tools/kubectl-pear.sh}"
NS="browser-box"
API="http://browser-box:6082"
# ------------------------------------------

STATE_DIR="$HOME/hooks/state"
CURSOR_FILE="$STATE_DIR/$HOOK_NAME.cursor"
mkdir -p "$STATE_DIR"

DRY=0
[ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ] && DRY=1

fetch_events() {
  local since="$1"
  local name="bb-hook-$RANDOM$RANDOM"
  local manifest out
  manifest=$(mktemp)
  cat > "$manifest" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $name
  namespace: $NS
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: api
          image: curlimages/curl:8.10.1
          command: ["sh", "-c", "curl -s --max-time 20 '$API/bb/events?since=$since&limit=200'"]
EOF
  "$KUBECTL" apply -f "$manifest" >/dev/null 2>&1 || true
  rm -f "$manifest"
  "$KUBECTL" -n "$NS" wait --for=condition=complete --timeout=90s "job/$name" >/dev/null 2>&1 || true
  out=$("$KUBECTL" -n "$NS" logs "job/$name" 2>/dev/null || true)
  "$KUBECTL" -n "$NS" delete job "$name" >/dev/null 2>&1 || true
  printf '%s' "$out"
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
