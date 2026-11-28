#!/usr/bin/env bash
# bb-api.sh - talk to the browser-box control API (cluster-internal, port 6082)
# from outside the cluster, through a throwaway Job driven by kubectl-pear.sh.
#
# Usage:
#   bb-api.sh tabs                     autoclose view (tab ids, urls, neverClose)
#   bb-api.sh subs                     list CDP event subscriptions
#   bb-api.sh subs add '<json>'        register a subscription, e.g.
#                                      {"event":"Page.frameNavigated","urlPattern":"example.com"}
#                                      {"event":"Target.targetDestroyed","targetId":"<tab id>"}
#                                      {"event":"Network.responseReceived","filter":{"field":"response.url","contains":"/api/"}}
#   bb-api.sh subs del <id>            remove a subscription
#   bb-api.sh events [since] [limit]   read the CDP event log (cursor = seq)
set -euo pipefail

KUBECTL="${BB_KUBECTL:-$HOME/workspace/tools/kubectl-pear.sh}"
NS="${BB_NAMESPACE:-browser-box}"
API="http://browser-box:6082"

# run_job <inner shell command>
# BB_BODY, if set, is exposed to the command as $BODY_B64 (base64).
run_job() {
  local name="bb-api-$RANDOM$RANDOM"
  local manifest out
  manifest=$(mktemp)
  {
    echo "apiVersion: batch/v1"
    echo "kind: Job"
    echo "metadata:"
    echo "  name: $name"
    echo "  namespace: $NS"
    echo "spec:"
    echo "  backoffLimit: 0"
    echo "  ttlSecondsAfterFinished: 300"
    echo "  template:"
    echo "    spec:"
    echo "      restartPolicy: Never"
    echo "      containers:"
    echo "        - name: api"
    echo "          image: curlimages/curl:8.10.1"
    if [ -n "${BB_BODY:-}" ]; then
      echo "          env:"
      echo "            - name: BODY_B64"
      echo "              value: $(printf '%s' "$BB_BODY" | base64 -w0)"
    fi
    printf '          command: ["sh", "-c", "%s"]\n' "$1"
  } > "$manifest"
  "$KUBECTL" apply -f "$manifest" >/dev/null
  rm -f "$manifest"
  "$KUBECTL" -n "$NS" wait --for=condition=complete --timeout=90s "job/$name" >/dev/null 2>&1 || true
  out=$("$KUBECTL" -n "$NS" logs "job/$name" 2>/dev/null || true)
  "$KUBECTL" -n "$NS" delete job "$name" >/dev/null 2>&1 || true
  if [ -z "$out" ]; then
    echo "bb-api: no response (job $name)" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

cmd="${1:-}"
case "$cmd" in
  tabs)
    run_job "curl -s --max-time 20 $API/bb/autoclose"
    ;;
  subs)
    case "${2:-}" in
      add)
        [ -n "${3:-}" ] || { echo "usage: bb-api.sh subs add '<json>'" >&2; exit 2; }
        BB_BODY="$3" run_job 'printf %s "$BODY_B64" | base64 -d | curl -s --max-time 20 -X POST -H "Content-Type: application/json" --data-binary @- http://browser-box:6082/bb/subscriptions'
        ;;
      del)
        [ -n "${3:-}" ] || { echo "usage: bb-api.sh subs del <id>" >&2; exit 2; }
        run_job "curl -s --max-time 20 -X DELETE -w ' HTTP %{http_code}\n' $API/bb/subscriptions/$3"
        ;;
      "")
        run_job "curl -s --max-time 20 $API/bb/subscriptions"
        ;;
      *) echo "unknown subs subcommand: $2" >&2; exit 2 ;;
    esac
    ;;
  events)
    run_job "curl -s --max-time 20 '$API/bb/events?since=${2:-0}&limit=${3:-100}'"
    ;;
  *)
    echo "usage: bb-api.sh {tabs|subs [add <json>|del <id>]|events [since] [limit]}" >&2
    exit 2
    ;;
esac
