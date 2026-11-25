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

# stock noVNC refuses SetDesktopSize while view-only; allow it so the resolution follows the viewer even before handover
RUN node -e 'const fs=require("fs");const p="/usr/share/novnc/core/rfb.js";let s=fs.readFileSync(p,"utf8");const t="if (!this._resizeSession) {\n            return;\n        }\n        if (this._viewOnly) {\n            return;\n        }";if(!s.includes(t)){console.error("rfb.js patch target not found");process.exit(1)}fs.writeFileSync(p,s.replace(t,"if (!this._resizeSession) {\n            return;\n        }"))'

# Chrome windows cannot go below 508px wide, so floor the framebuffer width there and scale the height along to keep the viewer's aspect ratio; BB_FORCE_SIZE pins an exact size instead
RUN node -e 'const fs=require("fs");const p="/usr/share/novnc/core/rfb.js";let s=fs.readFileSync(p,"utf8");const t="        const size = this._screenSize();\n\n        // Do we actually change anything?";if(!s.includes(t)){console.error("rfb.js resize patch target not found");process.exit(1)}fs.writeFileSync(p,s.replace(t,"        const size = this._screenSize();\n        const minW = window.BB_MIN_FB_WIDTH || 508;\n        if (size.w > 0 && size.w < minW) {\n            size.h = Math.round(size.h * minW / size.w);\n            size.w = minW;\n        }\n        if (window.BB_FORCE_SIZE) {\n            size.w = window.BB_FORCE_SIZE.w;\n            size.h = window.BB_FORCE_SIZE.h;\n        }\n\n        // Do we actually change anything?"))'

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
