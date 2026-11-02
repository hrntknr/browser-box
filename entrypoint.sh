#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"
GL_ARGS="--disable-gpu --enable-unsafe-swiftshader"

gpu=0
case "${GPU:-auto}" in
  1) gpu=1 ;;
  auto)
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
      gpu=1
    fi
    ;;
  0) ;;
  *) echo "GPU must be 0, 1 or auto" >&2; exit 1 ;;
esac
if [ "$gpu" = 1 ]; then
  echo "[gpu] $(nvidia-smi -L 2>/dev/null || true)"
  GL_ARGS="--use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface \
--ignore-gpu-blocklist --enable-unsafe-webgpu"
fi

CHROME_ARGS="--user-data-dir=/data/profile \
--remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
--no-first-run --no-default-browser-check --no-sandbox --test-type \
--hide-crash-restore-bubble --start-maximized $GL_ARGS about:blank"

rm -f /tmp/.X99-lock
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp &
XVFB_PID=$!
fluxbox >/dev/null 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -quiet &
X11VNC_PID=$!
websockify --web=/usr/share/novnc 127.0.0.1:6080 localhost:5900 &
WS_PID=$!

until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.2; done

apt-get update -qq
npx --yes playwright install chrome
rm -f /data/profile/Singleton*
mkdir -p /run/dbus
dbus-daemon --system --fork
eval "$(dbus-launch --sh-syntax)"
google-chrome-stable $CHROME_ARGS &

while :; do
  kill -0 "$XVFB_PID" 2>/dev/null || exit 1
  kill -0 "$X11VNC_PID" 2>/dev/null || exit 1
  kill -0 "$WS_PID" 2>/dev/null || exit 1
  sleep 5
done
