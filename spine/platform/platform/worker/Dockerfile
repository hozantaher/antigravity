# ============================================================
# Rozporuj.com PDF worker (BullMQ + LibreOffice)
# Standalone Dockerfile — Railway does not support --target
# Build context: services/worker (set in .github/workflows/go-services-ci.yml)
# ============================================================
#
# Standalone install — pass --ignore-workspace because services/worker
# carries its own pnpm-lock.yaml and the parent monorepo's
# pnpm-workspace.yaml is NOT in this build context.
# Drops the legacy `desktop-extension/server/utils.js` COPY: that file
# lives in services/scrapers (not services/worker), worker code never
# imports it, and the COPY broke every CI Docker build with
# "failed to calculate checksum of ref ... desktop-extension: not found".

# Stage 1: Install dependencies
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN pnpm install --frozen-lockfile --ignore-workspace

# Stage 2: Runtime
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-dejavu curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

RUN groupadd --gid 1001 app && useradd --uid 1001 --gid app --create-home app

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json /app/pnpm-lock.yaml ./
COPY tsconfig.json ./
COPY lib/ ./lib/
COPY scripts/lib/ ./scripts/lib/
COPY worker/ ./worker/

RUN mkdir -p data && chown app:app data

ENV NODE_ENV=production
ENV HEALTH_PORT=8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -f http://localhost:8090/healthz || exit 1

USER app
CMD ["npx", "tsx", "worker/index.ts"]
