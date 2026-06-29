# Garaaage MCP
![Version](https://img.shields.io/badge/version-v1.1.1-blue)


Node-based MCP server exposing tools and resources over stdio or authenticated HTTP mode.

## Maturity

Current state: `stabilizing`

This service has a strong automated test surface but previously lacked a canonical README.

## Stack

- Node.js
- TypeScript
- MCP SDK
- Express
- PostgreSQL
- Redis optional
- Docker

## Purpose

This service provides MCP-compatible access to Garaaage data and tools.

Two main runtime modes exist:

- `stdio` for local MCP-style execution
- `http` for remote authenticated MCP access

## Run

```bash
cd /Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp
pnpm install
pnpm mcp
```

Remote HTTP mode:

```bash
cd /Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp
export MCP_ISSUER_URL=https://example.com
export MCP_SECRET=change-me
pnpm mcp:remote
```

## Test

```bash
cd /Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp
pnpm test
```

Verification status:

- `pnpm test` was run during stabilization on `2026-04-04`
- the suite is not fully sandbox-stable in this environment because HTTP/E2E tests require local socket binding
- observed failures were tied to `EPERM` on `0.0.0.0` listen attempts rather than an obvious app-logic regression

## Required Environment

For HTTP mode:

- `MCP_ISSUER_URL`
- `MCP_SECRET`

Common optional runtime inputs visible in code:

- `MCP_PORT`
- `REDIS_URL`
- `TYPESENSE_URL` or `MEILI_URL`
- `TYPESENSE_API_KEY` or `MEILI_API_KEY`
- `LOG_LEVEL`
- `LOKI_URL`

## Documentation

### Canonical SpecKit Surface

Use these as the active truth for the service:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp/README.md)
  - service identity, runtime modes, run/test entrypoints, environment, and known gaps

Interpretation rule:

- if future notes or reports disagree with the README, reconcile toward the README until a real additional documentation surface is explicitly introduced

### Reference Surface

These are useful, but they are not service documentation truth surfaces:

- [SPECKIT-DOC-MAP.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp/SPECKIT-DOC-MAP.md)
- [package.json](/Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp/package.json)
- [mcp-server/index.ts](/Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp/mcp-server/index.ts)
- [mcp-server/http.ts](/Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp/mcp-server/http.ts)
- [Dockerfile](/Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp/Dockerfile)

Use the reference surface for:

- document role classification
- implementation lookup
- runtime entrypoint inspection

### Key Canonical Docs

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Service identity, run/test surface, env, maturity, and gaps |
| [package.json](package.json) | Script surface and dependency definition |
| [mcp-server/index.ts](mcp-server/index.ts) | Stdio MCP entrypoint |
| [mcp-server/http.ts](mcp-server/http.ts) | Remote HTTP MCP entrypoint |
| [Dockerfile](Dockerfile) | Container build targets |

## Runtime Notes

- HTTP mode hard-fails without `MCP_ISSUER_URL` and `MCP_SECRET`
- Redis is optional; memory-backed auth storage is used as fallback
- the Dockerfile also contains worker/indexer targets, so deployment should choose the intended image target deliberately

## Known Gaps

- no changelog yet
- no ADR yet
- no explicit deployment guide beyond Docker and Railway config
- HTTP/E2E verification should be repeated in an environment that permits local server binds
