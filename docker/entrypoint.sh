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
websockify 127.0.0.1:6081 localhost:5900 &
WS_PID=$!
node --experimental-websocket /app/server.mjs &
SRV_PID=$!

until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.2; done

# fluxbox is supervised: with no WM, maximize requests go nowhere and Chrome stops following framebuffer resizes
(
  while :; do
    fluxbox >/dev/null 2>&1 || true
    sleep 1
  done
) &
FLUX_PID=$!

if ! command -v google-chrome-stable >/dev/null 2>&1; then
  apt-get update -qq
  npx --yes playwright install chrome
fi
rm -f /data/profile/Singleton*
mkdir -p /run/dbus
rm -f /run/dbus/pid /run/dbus/system_bus_socket   # stale after docker restart
dbus-daemon --system --fork
eval "$(dbus-launch --sh-syntax)"
node /app/cdp-forward.mjs &
FWD_PID=$!

# merge the pref at every start: the profile is a volume, so the seeded Preferences in the image is not what persists
node /app/merge-preferences.mjs || true

# Singleton cleanup is safe here: this loop only runs while Chrome is down
(
  while :; do
    rm -f /data/profile/Singleton*
    google-chrome-stable $CHROME_ARGS || true
    sleep 2
  done
) &
CHROME_PID=$!

# judge by geometry, not the state atoms: fluxbox can shrink a window while keeping the maximized atoms, and re-adding a set state is a no-op
(
  while :; do
    sleep 2
    geo_root=$(xdotool getdisplaygeometry 2>/dev/null || true)
    set -- $geo_root
    dw=${1:-}; dh=${2:-}
    [ -n "$dw" ] && [ -n "$dh" ] || continue
    for id in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -o '0x[0-9a-fA-F]\+'); do
      state=$(xprop -id "$id" _NET_WM_STATE 2>/dev/null || true)
      if echo "$state" | grep -q _NET_WM_STATE_HIDDEN; then
        wmctrl -i -r "$id" -b remove,hidden 2>/dev/null || true
        continue
      fi
      if xprop -id "$id" WM_CLASS 2>/dev/null | grep -qi google-chrome; then
        geo=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null || true)
        WIDTH=0; HEIGHT=0
        if [ -n "$geo" ]; then eval "$geo"; fi
        if echo "$state" | grep -q _NET_WM_STATE_MAXIMIZED_HORZ \
           && echo "$state" | grep -q _NET_WM_STATE_MAXIMIZED_VERT \
           && [ "${WIDTH:-0}" -ge $((dw - 2)) ] && [ "${HEIGHT:-0}" -ge $((dh - 2)) ]; then
          continue
        fi
        wmctrl -i -r "$id" -b remove,maximized_vert,maximized_horz 2>/dev/null || true
        wmctrl -i -r "$id" -b add,maximized_vert,maximized_horz 2>/dev/null || true
      fi
    done
  done
) &
WATCH_PID=$!

# close Chrome over CDP: a plain SIGTERM leaves the Singleton lock behind and counts as a crash
shutdown() {
  trap - TERM INT
  kill "$CHROME_PID" "$WATCH_PID" 2>/dev/null || true
  node --experimental-websocket /app/close-chrome.mjs 2>/dev/null || true
  i=0
  while pgrep -x chrome >/dev/null 2>&1 && [ "$i" -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done
  pkill -TERM -x chrome 2>/dev/null || true
  i=0
  while pgrep -x chrome >/dev/null 2>&1 && [ "$i" -lt 5 ]; do
    sleep 1
    i=$((i + 1))
  done
  kill "$FLUX_PID" "$FWD_PID" "$SRV_PID" "$WS_PID" "$XVNC_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

while :; do
  kill -0 "$XVNC_PID" 2>/dev/null || exit 1
  kill -0 "$FLUX_PID" 2>/dev/null || exit 1
  kill -0 "$WS_PID" 2>/dev/null || exit 1
  kill -0 "$SRV_PID" 2>/dev/null || exit 1
  kill -0 "$FWD_PID" 2>/dev/null || exit 1
  kill -0 "$CHROME_PID" 2>/dev/null || exit 1
  kill -0 "$WATCH_PID" 2>/dev/null || exit 1
  sleep 5 & wait $!
done
