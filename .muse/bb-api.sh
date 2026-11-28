#!/usr/bin/env bash
# bb-api.sh - talk to the browser-box control API (port 6082) over HTTP.
#
# The control API is cluster-internal. The standard route is the sshmitm
# SSH forward (see bb-tunnel.sh): run bb-tunnel.sh first, then this CLI
# talks to the forwarded port on localhost. BB_API_URL overrides the
# base URL for other setups, e.g.
#   BB_API_URL=http://browser-box:6082   (inside the cluster / compose network)
#
# Usage:
#   bb-api.sh tabs                       autoclose view (tab ids, urls, neverClose)
#   bb-api.sh autoclose minutes <n>      set the idle minutes before tabs close
#   bb-api.sh autoclose pause <minutes>  pause autoclose for a while
#   bb-api.sh autoclose suspend          pause autoclose until resumed
#   bb-api.sh autoclose resume           resume autoclose
#   bb-api.sh keeps                      list tabs excluded from autoclose
#   bb-api.sh keep <tab id>              exclude a tab from autoclose
#   bb-api.sh unkeep <tab id>            remove the exclusion
#   bb-api.sh scripts                    list userscripts
#   bb-api.sh scripts get <id>           show one userscript with its source
#   bb-api.sh scripts add <file>         register a userscript from a file
#   bb-api.sh scripts del <id>           remove a userscript
#   bb-api.sh subs                       list CDP event subscriptions
#   bb-api.sh subs add '<json>'          register a subscription, e.g.
#                                        {"event":"Page.frameNavigated","urlPattern":"example.com"}
#                                        {"event":"Target.targetDestroyed","targetId":"<tab id>"}
#                                        {"event":"Network.responseReceived","filter":{"field":"response.url","contains":"/api/"}}
#   bb-api.sh subs del <id>              remove a subscription
#   bb-api.sh events [since] [limit]     read the CDP event log (cursor = seq)
set -euo pipefail

API="${BB_API_URL:-http://localhost:16082}"

get() { curl -s --max-time 20 "$API$1"; }
del() { curl -s --max-time 20 -X DELETE -w ' HTTP %{http_code}\n' "$API$1"; }
post_json() { printf '%s' "$2" | curl -s --max-time 20 -X POST -H "Content-Type: application/json" --data-binary @- "$API$1"; }

cmd="${1:-}"
case "$cmd" in
  tabs)
    get /bb/autoclose
    ;;
  autoclose)
    case "${2:-}" in
      minutes)
        [ -n "${3:-}" ] || { echo "usage: bb-api.sh autoclose minutes <n>" >&2; exit 2; }
        post_json /bb/autoclose "{\"idleMinutes\": $3}"
        ;;
      pause)
        [ -n "${3:-}" ] || { echo "usage: bb-api.sh autoclose pause <minutes>" >&2; exit 2; }
        post_json /bb/autoclose "{\"pauseMinutes\": $3}"
        ;;
      suspend)
        post_json /bb/autoclose '{"paused": true}'
        ;;
      resume)
        post_json /bb/autoclose '{"resume": true}'
        ;;
      *) echo "usage: bb-api.sh autoclose {minutes <n>|pause <minutes>|suspend|resume}" >&2; exit 2 ;;
    esac
    ;;
  keeps)
    get /bb/autoclose/tabs
    ;;
  keep)
    [ -n "${2:-}" ] || { echo "usage: bb-api.sh keep <tab id>" >&2; exit 2; }
    post_json "/bb/autoclose/tabs/$2" '{}'
    ;;
  unkeep)
    [ -n "${2:-}" ] || { echo "usage: bb-api.sh unkeep <tab id>" >&2; exit 2; }
    del "/bb/autoclose/tabs/$2"
    ;;
  scripts)
    case "${2:-}" in
      add)
        [ -n "${3:-}" ] && [ -f "$3" ] || { echo "usage: bb-api.sh scripts add <file>" >&2; exit 2; }
        curl -s --max-time 20 -X POST --data-binary @"$3" "$API/bb/userscripts"
        ;;
      get)
        [ -n "${3:-}" ] || { echo "usage: bb-api.sh scripts get <id>" >&2; exit 2; }
        get "/bb/userscripts/$3"
        ;;
      del)
        [ -n "${3:-}" ] || { echo "usage: bb-api.sh scripts del <id>" >&2; exit 2; }
        del "/bb/userscripts/$3"
        ;;
      "")
        get /bb/userscripts
        ;;
      *) echo "unknown scripts subcommand: $2" >&2; exit 2 ;;
    esac
    ;;
  subs)
    case "${2:-}" in
      add)
        [ -n "${3:-}" ] || { echo "usage: bb-api.sh subs add '<json>'" >&2; exit 2; }
        post_json /bb/subscriptions "$3"
        ;;
      del)
        [ -n "${3:-}" ] || { echo "usage: bb-api.sh subs del <id>" >&2; exit 2; }
        del "/bb/subscriptions/$3"
        ;;
      "")
        get /bb/subscriptions
        ;;
      *) echo "unknown subs subcommand: $2" >&2; exit 2 ;;
    esac
    ;;
  events)
    get "/bb/events?since=${2:-0}&limit=${3:-100}"
    ;;
  *)
    echo "usage: bb-api.sh {tabs|autoclose|keeps|keep|unkeep|scripts|subs|events} ..." >&2
    exit 2
    ;;
esac
echo
