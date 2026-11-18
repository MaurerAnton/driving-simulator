# SPDX-License-Identifier: AGPL-3.0-only
# Fahrsim Baunatal server – container image.
# Build from the repository root:   docker build -t fahrsim-server server
# No npm install: the server has no dependencies (Node's own http, sqlite and crypto).
FROM node:26-slim

ENV NODE_ENV=production \
    FAHRSIM_DATA=/data \
    FAHRSIM_PORT=8080 \
    FAHRSIM_HOST=0.0.0.0

WORKDIR /app
COPY package.json NOTICE.md README.md PROTOCOL.md ./
COPY src ./src

# a user without rights, owning only /data
RUN groupadd --system fahrsim && useradd --system --gid fahrsim --home-dir /data --shell /usr/sbin/nologin fahrsim \
    && mkdir -p /data && chown fahrsim:fahrsim /data
USER fahrsim
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.FAHRSIM_PORT||8080)+'/api/v1/info').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "src/main.ts"]
