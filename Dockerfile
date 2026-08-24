# syntax=docker/dockerfile:1
#
# Production-oriented multi-stage image for ol-node-rest.
# Same image, different process commands:
#   API:         node dist/server.js          (default CMD)
#   Worker:      node dist/worker.js
#   Face worker: node dist/worker-face-index.js
#
# Build targets:
#   runner (default) — pruned production runtime
#   builder          — full deps (useful for `prisma migrate deploy` in compose)
#
# Target platform for first production deploy: linux/amd64 (EC2 x86_64).

ARG NODE_VERSION=20

# ─── Build (full deps: typescript + prisma CLI) ───────────────────────────────
FROM --platform=linux/amd64 node:${NODE_VERSION}-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src/

RUN npx prisma generate && npm run build

# ─── Production node_modules (prune after generate so client engines remain) ──
FROM builder AS pruned
RUN npm prune --omit=dev

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM --platform=linux/amd64 node:${NODE_VERSION}-bookworm-slim AS runner

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=pruned --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=pruned --chown=appuser:nodejs /app/dist ./dist
COPY --from=pruned --chown=appuser:nodejs /app/package.json ./package.json
COPY --from=pruned --chown=appuser:nodejs /app/prisma ./prisma

USER appuser

EXPOSE 3000

# Node 20 has native fetch — no curl/wget solely for health checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000; fetch('http://127.0.0.1:'+p+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
