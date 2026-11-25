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
websockify 127.0.0.1:6081 localhost:5900 &
WS_PID=$!
node --experimental-websocket /app/server.mjs &
SRV_PID=$!

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

# Keep Chrome on the system frame: with its own frame it draws minimize /
# maximize / close buttons that fluxbox cannot strip, while the system
# frame gets Deco NONE like every other window. The profile lives on a
# volume, so merge the pref in at every start instead of relying on the
# seeded Preferences in the image.
node -e 'const fs=require("fs");const p="/data/profile/Default/Preferences";let j={};try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}if(!j.browser)j.browser={};j.browser.custom_chrome_frame=false;fs.mkdirSync("/data/profile/Default",{recursive:true});fs.writeFileSync(p,JSON.stringify(j))' || true

# Chrome supervisor: closing the last tab exits Chrome, so relaunch it.
# Singleton cleanup is safe here because the loop only runs while Chrome
# is down. Container shutdown kills PID 1 and the whole namespace with it.
(
  while :; do
    rm -f /data/profile/Singleton*
    google-chrome-stable $CHROME_ARGS || true
    sleep 2
  done
) &
CHROME_PID=$!

# Minimize containment: there is no taskbar to restore a window from, so
# any iconified window is deiconified again right away. A Chrome window
# left in normal state (e.g. after a minimize/restore race, or a session
# restore with a saved normal placement) stops following framebuffer
# resizes, so Chrome windows are pulled back to maximized. The state
# atoms alone cannot be trusted for this: a move/resize request sent to
# a maximized window makes fluxbox shrink the window while keeping the
# maximized atoms, and re-adding a state that is already set is a no-op,
# so check the actual geometry against the desktop and clear the state
# before re-adding it when the two disagree.
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

while :; do
  kill -0 "$XVNC_PID" 2>/dev/null || exit 1
  kill -0 "$WS_PID" 2>/dev/null || exit 1
  kill -0 "$SRV_PID" 2>/dev/null || exit 1
  kill -0 "$FWD_PID" 2>/dev/null || exit 1
  kill -0 "$CHROME_PID" 2>/dev/null || exit 1
  kill -0 "$WATCH_PID" 2>/dev/null || exit 1
  sleep 5
done
