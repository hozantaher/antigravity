# garaaage-worker

## Stack
TypeScript, Node.js, BullMQ (Redis), Anthropic SDK, SendGrid, Firebase Admin, Zod, vitest

## Commands
- Test: `pnpm test`
- Start: `pnpm start`

## Health endpoint
- GET `/healthz` on port `HEALTH_PORT` (default 8090)
- Returns JSON: `{ status: "ok", uptime_seconds: <int>, service: "worker", timestamp: "<ISO>" }`
- Used by Docker HEALTHCHECK

## Rules
- All job handlers must be idempotent — BullMQ may retry on failure, so repeated execution must be safe
- Redis connection uses env vars for Railway internal networking — never hardcode hostnames
- Anthropic API calls must go through the model-tier router; do not call the SDK directly with a hardcoded model name
