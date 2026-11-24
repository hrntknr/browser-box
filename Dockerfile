FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LANG=ja_JP.UTF-8 \
    TZ=Asia/Tokyo

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg locales dbus dbus-x11 \
      tigervnc-standalone-server xfonts-base fluxbox novnc websockify \
      fonts-noto-cjk fonts-vlgothic fonts-ipafont \
      xclip procps nodejs npm libvulkan1 vulkan-tools \
    && sed -i 's/^# *ja_JP.UTF-8 UTF-8/ja_JP.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && ln -sf /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && rm -rf /var/lib/apt/lists/*

# stock noVNC refuses SetDesktopSize while view-only; allow it so the remote
# resolution follows the viewer window even before handover
RUN node -e 'const fs=require("fs");const p="/usr/share/novnc/core/rfb.js";let s=fs.readFileSync(p,"utf8");const t="if (!this._resizeSession) {\n            return;\n        }\n        if (this._viewOnly) {\n            return;\n        }";if(!s.includes(t)){console.error("rfb.js patch target not found");process.exit(1)}fs.writeFileSync(p,s.replace(t,"if (!this._resizeSession) {\n            return;\n        }"))'

RUN mkdir -p /data/profile/Default \
    && printf '{"intl":{"accept_languages":"ja,en-US;q=0.9,en;q=0.8"}}' \
       > /data/profile/Default/Preferences

RUN mkdir -p /etc/opt/chrome/policies/managed \
    && printf '{"ExtensionInstallForcelist":["mfnicocicmmlkpjnaffgihfjhdgjkdjg;https://clients2.google.com/service/update2/crx"]}' \
       > /etc/opt/chrome/policies/managed/browse.json

RUN npx --yes playwright install chrome

COPY fluxbox/ /root/.fluxbox/
COPY ui/index.html /usr/share/novnc/index.html
COPY entrypoint.sh /app/entrypoint.sh
EXPOSE 9222 6080

CMD ["/bin/sh", "/app/entrypoint.sh"]
