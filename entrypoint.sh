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
--remote-debugging-port=9223 \
--no-first-run --no-default-browser-check --no-sandbox --test-type \
--hide-crash-restore-bubble --start-maximized $GL_ARGS about:blank"

rm -f /tmp/.X99-lock
Xvnc "$DISPLAY" -geometry 1920x1080 -depth 24 -rfbport 5900 -nolisten tcp \
  -localhost -SecurityTypes None -AlwaysShared &
XVNC_PID=$!
fluxbox >/dev/null 2>&1 &
websockify --web=/usr/share/novnc "${NOVNC_BIND:-127.0.0.1}:6080" localhost:5900 &
WS_PID=$!

until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.2; done

if ! command -v google-chrome-stable >/dev/null 2>&1; then
  apt-get update -qq
  npx --yes playwright install chrome
fi
rm -f /data/profile/Singleton*
mkdir -p /run/dbus
rm -f /run/dbus/pid /run/dbus/system_bus_socket   # stale after docker restart
dbus-daemon --system --fork
eval "$(dbus-launch --sh-syntax)"
node -e 'const n=require("net");n.createServer(c=>{const u=n.connect(9223,"127.0.0.1");c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy())}).listen(9222,"0.0.0.0")' &
FWD_PID=$!
google-chrome-stable $CHROME_ARGS &

while :; do
  kill -0 "$XVNC_PID" 2>/dev/null || exit 1
  kill -0 "$WS_PID" 2>/dev/null || exit 1
  kill -0 "$FWD_PID" 2>/dev/null || exit 1
  sleep 5
done
