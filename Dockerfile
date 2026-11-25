FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LANG=ja_JP.UTF-8 \
    TZ=Asia/Tokyo

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg locales dbus dbus-x11 \
      tigervnc-standalone-server xfonts-base fluxbox novnc websockify x11-xserver-utils \
      wmctrl xdotool x11-utils \
      fonts-noto-cjk fonts-vlgothic fonts-ipafont \
      xclip procps nodejs npm libvulkan1 vulkan-tools \
    && sed -i 's/^# *ja_JP.UTF-8 UTF-8/ja_JP.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && ln -sf /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && rm -rf /var/lib/apt/lists/*

# stock noVNC refuses SetDesktopSize while view-only; allow it so the remote
# resolution follows the viewer window even before handover
RUN node -e 'const fs=require("fs");const p="/usr/share/novnc/core/rfb.js";let s=fs.readFileSync(p,"utf8");const t="if (!this._resizeSession) {\n            return;\n        }\n        if (this._viewOnly) {\n            return;\n        }";if(!s.includes(t)){console.error("rfb.js patch target not found");process.exit(1)}fs.writeFileSync(p,s.replace(t,"if (!this._resizeSession) {\n            return;\n        }"))'

# the remote Chrome window cannot go below 508px wide, so floor the
# requested framebuffer width there: a narrower viewer keeps a 508px
# desktop and scales the view down instead of cropping the window.
# BB_FORCE_SIZE (set by the UI's PC button) pins an exact size instead.
RUN node -e 'const fs=require("fs");const p="/usr/share/novnc/core/rfb.js";let s=fs.readFileSync(p,"utf8");const t="        const size = this._screenSize();\n\n        // Do we actually change anything?";if(!s.includes(t)){console.error("rfb.js resize patch target not found");process.exit(1)}fs.writeFileSync(p,s.replace(t,"        const size = this._screenSize();\n        if (size.w < (window.BB_MIN_FB_WIDTH || 508)) {\n            size.w = window.BB_MIN_FB_WIDTH || 508;\n        }\n        if (window.BB_FORCE_SIZE) {\n            size.w = window.BB_FORCE_SIZE.w;\n            size.h = window.BB_FORCE_SIZE.h;\n        }\n\n        // Do we actually change anything?"))'

# a window resize makes noVNC ask for every intermediate size; send only
# once the wanted size has been stable for 250ms, so the framebuffer does
# not flip through them. The final size is still always reached: the
# deferred retry re-reads the then-current size, and the UI reconciler
# keeps asking until the framebuffer matches.
RUN node -e 'const fs=require("fs");const p="/usr/share/novnc/core/rfb.js";let s=fs.readFileSync(p,"utf8");const t="        // Do we actually change anything?\n        if (size.w === this._fbWidth && size.h === this._fbHeight) {\n            return;\n        }\n";if(!s.includes(t)){console.error("rfb.js debounce patch target not found");process.exit(1)}fs.writeFileSync(p,s.replace(t,t+"\n        const bbKey = size.w + \"x\" + size.h;\n        if (this._bbWantKey !== bbKey) {\n            this._bbWantKey = bbKey;\n            this._bbWantAt = Date.now();\n        }\n        if (Date.now() - this._bbWantAt < 250) {\n            clearTimeout(this._bbWantTimer);\n            this._bbWantTimer = setTimeout(this._requestRemoteResize.bind(this), 260);\n            return;\n        }\n"))'

RUN mkdir -p /data/profile/Default \
    && printf '{"intl":{"accept_languages":"ja,en-US;q=0.9,en;q=0.8"},"browser":{"custom_chrome_frame":false}}' \
       > /data/profile/Default/Preferences

RUN npx --yes playwright install chrome

COPY fluxbox/ /root/.fluxbox/
COPY fbsetbg /usr/bin/fbsetbg
RUN chmod 755 /usr/bin/fbsetbg
COPY ui/index.html /usr/share/novnc/index.html
COPY entrypoint.sh /app/entrypoint.sh
COPY server.mjs /app/server.mjs
EXPOSE 9222 6080

CMD ["/bin/sh", "/app/entrypoint.sh"]
