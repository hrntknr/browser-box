#!/usr/bin/env bash
# bb-tunnel.sh - open the SSH forward to the browser-box control API.
#
# The control API (port 6082) is cluster-internal. The standard route in
# is sshmitm (10.8.1.5:2222), which splice-forwards to browser-box for
# clients holding the authorized SSH key. This script starts the forward
#   127.0.0.1:16082 -> browser-box.browser-box.svc.cluster.local:6082
# if it is not already up, and leaves it running in the background.
#
# Env:
#   BB_LOCAL_PORT   local port (default 16082)
#   BB_SSHMITM      ssh destination (default muse@10.8.1.5)
#   BB_SSH_KEY      private key (default ~/.ssh/id_ed25519)
#   HTTPS_PROXY     when set, ssh goes through its CONNECT proxy on
#                   port 3130 (the sandbox VM route); unset it on hosts
#                   that reach the tailnet directly.
set -euo pipefail

PORT="${BB_LOCAL_PORT:-16082}"
DEST="${BB_SSHMITM:-muse@10.8.1.5}"
KEY="${BB_SSH_KEY:-$HOME/.ssh/id_ed25519}"
TARGET="browser-box.browser-box.svc.cluster.local:6082"
STATE_DIR="$HOME/.cache/bb-tunnel"
mkdir -p "$STATE_DIR"

if curl -s --max-time 3 "http://127.0.0.1:$PORT/bb/autoclose" >/dev/null 2>&1; then
  echo "bb-tunnel: already up on 127.0.0.1:$PORT"
  exit 0
fi

SSH_OPTS=(-N -L "127.0.0.1:$PORT:$TARGET" -p 2222
  -o ExitOnForwardFailure=yes
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=accept-new
  -i "$KEY")
if [ -n "${HTTPS_PROXY:-}" ]; then
  PROXY_HOST=$(printf '%s' "$HTTPS_PROXY" | sed -E 's|^(https?://)?([^/@]*@)?([^/:]+).*|\3|')
  SSH_OPTS+=(-o "ProxyCommand=nc -X connect -x $PROXY_HOST:3130 %h %p")
fi

nohup ssh "${SSH_OPTS[@]}" "$DEST" > "$STATE_DIR/ssh.log" 2>&1 &
echo $! > "$STATE_DIR/ssh.pid"

for i in $(seq 1 20); do
  if curl -s --max-time 3 "http://127.0.0.1:$PORT/bb/autoclose" >/dev/null 2>&1; then
    echo "bb-tunnel: up on 127.0.0.1:$PORT (pid $(cat "$STATE_DIR/ssh.pid"))"
    exit 0
  fi
  sleep 1
done
echo "bb-tunnel: forward did not come up; see $STATE_DIR/ssh.log" >&2
exit 1
