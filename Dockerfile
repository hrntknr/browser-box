FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      xvfb fluxbox x11vnc novnc websockify \
      fonts-noto-cjk xclip procps \
      nodejs npm \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 box && mkdir -p /data/profile && chown -R box:box /data

COPY entrypoint.sh /app/entrypoint.sh
EXPOSE 9222 6080

CMD ["/bin/sh", "/app/entrypoint.sh"]
