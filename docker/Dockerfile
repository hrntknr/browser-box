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

COPY patch-rfb.mjs /tmp/patch-rfb.mjs
RUN node /tmp/patch-rfb.mjs

COPY profile-preferences.json /data/profile/Default/Preferences

RUN npx --yes playwright install chrome

COPY fluxbox/ /root/.fluxbox/
COPY fbsetbg /usr/bin/fbsetbg
RUN chmod 755 /usr/bin/fbsetbg
COPY ui/index.html /usr/share/novnc/index.html
COPY entrypoint.sh /app/entrypoint.sh
COPY package.json package-lock.json /app/
RUN cd /app && npm ci --omit=dev --ignore-scripts
COPY server.mjs /app/server.mjs
COPY cdp-forward.mjs merge-preferences.mjs close-chrome.mjs events.mjs /app/
EXPOSE 9222 6080

CMD ["/bin/sh", "/app/entrypoint.sh"]
