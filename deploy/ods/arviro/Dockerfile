# Arviro as an ODS (Osmantic Deployment System) extension: Node.js, kiwix-serve, osmium and pdftotext in one image.
# The source is fetched from GitHub at ARVIRO_REF, so this folder can be dropped into ODS on its own.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ghcr.io/kiwix/kiwix-serve:3.8.2@sha256:e478554a9920412eeb5ce1d73f24e4b28445ebed233187cdd03c623c32be46a5 AS kiwix

FROM ${NODE_IMAGE} AS source
ARG ARVIRO_REPO=https://github.com/ymebosma/arviro.git
ARG ARVIRO_REF=main
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${ARVIRO_REF}" "${ARVIRO_REPO}" /opt/arviro \
 && cd /opt/arviro \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf .git

FROM ${NODE_IMAGE}
# osmium indexes map extracts, pdftotext reads PDF files; kiwix-serve (a static binary) serves ZIM files.
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=kiwix /usr/local/bin/kiwix-serve /usr/local/bin/kiwix-serve
COPY --from=source /opt/arviro /opt/arviro
RUN mkdir -p /data && chown 1000:1000 /data \
 && chmod +x /opt/arviro/deploy/ods/arviro/entrypoint.sh

USER 1000:1000
ENV NODE_ENV=production \
    ARVIRO_DATA=/data \
    ARVIRO_CONFIG=/data/config.json
VOLUME ["/data"]
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8765/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/opt/arviro/deploy/ods/arviro/entrypoint.sh"]
