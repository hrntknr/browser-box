#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"
CHROME_ARGS="--user-data-dir=/data/profile \
--remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
--no-first-run --no-default-browser-check --no-sandbox \
--disable-gpu --window-size=1920,1080 about:blank"

rm -f /tmp/.X99-lock
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp &
XVFB_PID=$!
fluxbox >/dev/null 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -quiet &
X11VNC_PID=$!
websockify --web=/usr/share/novnc 6080 localhost:5900 &
WS_PID=$!

until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.2; done

apt-get update -qq
npx --yes playwright install chrome
rm -f /data/profile/Singleton*
google-chrome-stable $CHROME_ARGS &

while :; do
  kill -0 "$XVFB_PID" 2>/dev/null || exit 1
  kill -0 "$X11VNC_PID" 2>/dev/null || exit 1
  kill -0 "$WS_PID" 2>/dev/null || exit 1
  sleep 5
done
