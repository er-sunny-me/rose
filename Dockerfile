# ─────────────────────────────────────────────────────────────
# Rose AI Agent Platform — production headless server image
# Build:  docker build -t rose-agent .
# Run:    docker run -p 3000:3000 -v rose-data:/data rose-agent
# ─────────────────────────────────────────────────────────────

# ── Stage 1: build ───────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
# better-sqlite3 needs build tooling only if a prebuild is missing
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --include=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY tsconfig.json ./
COPY src ./src
COPY ui/package.json ./ui/package.json
RUN npm run build

# UI is optional in the container; build it when present so / serves the panel.
COPY ui ./ui
RUN cd ui && npm ci --no-audit --no-fund && npm run build || echo "UI build skipped"

# ── Stage 2: runtime ─────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Non-root user (§110)
RUN groupadd -r rose && useradd -r -g rose rose

COPY package.json package-lock.json* ./
# Production deps only — no dev toolchain, no caches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/ui/dist ./ui/dist

# Persistent locations (§114). Mount these volumes in production:
#   /data/.rose     config, auth token, secrets, browser sessions
#   /app/memory     memory vault + vector index
#   /app/data       automations + event store data
RUN mkdir -p /data/.rose /app/memory /app/data \
    && chown -R rose:rose /data /app

USER rose

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "server"]
