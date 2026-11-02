FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LANG=ja_JP.UTF-8 \
    TZ=Asia/Tokyo

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg locales dbus dbus-x11 \
      xvfb fluxbox x11vnc novnc websockify \
      fonts-noto-cjk fonts-vlgothic fonts-ipafont \
      xclip procps nodejs npm \
    && sed -i 's/^# *ja_JP.UTF-8 UTF-8/ja_JP.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && ln -sf /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && rm -rf /var/lib/apt/lists/* \
    && printf '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1">\n' \
       > /usr/share/novnc/index.html

RUN mkdir -p /data/profile/Default \
    && printf '{"intl":{"accept_languages":"ja,en-US;q=0.9,en;q=0.8"}}' \
       > /data/profile/Default/Preferences

COPY entrypoint.sh /app/entrypoint.sh
EXPOSE 9222 6080

CMD ["/bin/sh", "/app/entrypoint.sh"]
