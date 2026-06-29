# garaaage-mcp

## Stack
TypeScript, Node.js, MCP SDK, Express 5, PostgreSQL (pg), Redis (ioredis), Typesense, Zod, vitest

## Commands
- Test: `pnpm test`
- Dev (HTTP mode): `pnpm mcp:remote`
- Dev (stdio mode): `pnpm mcp`

## Rules
- Database and Redis connections use the `FIRMY_DSN` env var for internal Railway networking — never hardcode hostnames or IPs
- All tool inputs must be validated with Zod schemas before any DB/Redis access
- MCP tools must remain stateless across calls; do not cache mutable state in module scope
