#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"

if [ "$(id -u)" = "0" ]; then
  apt-get update -qq
  npx --yes playwright install chrome
  chown -R box:box /data/profile
  exec runuser -u box -- /bin/sh /app/entrypoint.sh
fi

rm -f /tmp/.X99-lock
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!
fluxbox >/dev/null 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -quiet &
X11VNC_PID=$!
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
WS_PID=$!

google-chrome-stable \
  --user-data-dir=/data/profile \
  --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1280,800 \
  about:blank >/dev/null 2>&1 &
CHROME_PID=$!

while :; do
  kill -0 "$XVFB_PID" 2>/dev/null || exit 1
  kill -0 "$X11VNC_PID" 2>/dev/null || exit 1
  kill -0 "$WS_PID" 2>/dev/null || exit 1
  kill -0 "$CHROME_PID" 2>/dev/null || exit 1
  sleep 5
done
