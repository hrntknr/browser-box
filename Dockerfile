FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xvfb fluxbox x11vnc novnc websockify \
      fonts-noto-cjk xclip procps \
      nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && printf '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1">\n' \
       > /usr/share/novnc/index.html

RUN mkdir -p /data/profile

COPY entrypoint.sh /app/entrypoint.sh
EXPOSE 9222 6080

CMD ["/bin/sh", "/app/entrypoint.sh"]
