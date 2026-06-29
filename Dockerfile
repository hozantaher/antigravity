FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/spine ./spine
COPY --from=builder /app/src ./src

# Proměnné prostředí lze přepsat za běhu (např. přes Railway)
ENV NODE_ENV=production
ENV REDIS_URL=redis://redis:6379

CMD ["npx", "ts-node", "--transpile-only", "src/index.ts", "daemon"]
