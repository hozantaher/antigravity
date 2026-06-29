# ============================================================
# Stage 1: Install dependencies and compile native modules
# ============================================================
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# Skip Playwright browser download — mcp stage doesn't need it,
# full stage gets browsers from the base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN pnpm install --frozen-lockfile

# ============================================================
# Stage 2: Shared app base (source + node_modules)
# ============================================================
FROM node:22-bookworm-slim AS app-base

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

RUN groupadd --gid 1001 app && useradd --uid 1001 --gid app --create-home app

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json /app/pnpm-lock.yaml ./
COPY tsconfig.json ./
COPY lib/ ./lib/
COPY mcp-server/ ./mcp-server/
COPY scripts/ ./scripts/

RUN mkdir -p data && chown app:app data

ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV MCP_PORT=3002
ENV NODE_ENV=production

EXPOSE 3002

# ============================================================
# Stage 3: MCP server (slim — no Playwright, no Chromium)
# ============================================================
FROM app-base AS mcp

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=600s \
    CMD node -e "fetch('http://localhost:' + (process.env.MCP_PORT || 3002) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["pnpm", "mcp:remote"]

# ============================================================
# Stage 4: Rozporuj.com PDF worker (BullMQ + LibreOffice)
# Build: docker build --target worker -t garaaage-worker .
# ============================================================
FROM app-base AS worker

RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

COPY worker/ ./worker/

USER app
CMD ["npx", "tsx", "worker/index.ts"]

# ============================================================
# Stage 5: Meilisearch indexer (one-off job — exits after indexing)
# Build: docker build --target indexer -t garaaage-indexer .
# Run on Railway as a service with DATABASE_URL + MEILI_URL + MEILI_API_KEY
# ============================================================
FROM app-base AS indexer

USER app
CMD ["npx", "tsx", "scripts/index-meilisearch.ts"]

# ============================================================
# Stage 6: Full image (with Playwright for mobile.de scraper)
# ============================================================
FROM mcr.microsoft.com/playwright:v1.58.0-noble AS full

RUN corepack enable pnpm

WORKDIR /app

COPY --from=app-base /app /app

RUN mkdir -p data && chown pwuser:pwuser data

ENV MCP_PORT=3002
ENV NODE_ENV=production

EXPOSE 3002

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=600s \
    CMD node -e "fetch('http://localhost:' + (process.env.MCP_PORT || 3002) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["pnpm", "mcp:remote"]
