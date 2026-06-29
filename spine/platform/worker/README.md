# Garaaage Worker

Background worker for queued document generation, file handling, PDF conversion, and result delivery.

## Maturity

Current state: `stabilizing`

The worker has a strong test surface and clear runtime entrypoint, but it previously lacked a canonical README.

## Stack

- Node.js
- TypeScript
- BullMQ
- Redis
- Firebase
- SendGrid
- Anthropic SDK
- Docker

## Purpose

This service processes queued jobs and produces deliverables for downstream applications.

Current pipeline visible in code:

1. download files from Firebase
2. generate analysis via Claude + MCP tooling
3. convert markdown to DOCX
4. convert DOCX to PDF
5. upload outputs
6. send result email

## Run

```bash
cd /Users/messingtomas/Taher/hozan-taher/services/garaaage-worker
pnpm install
pnpm start
```

## Test

```bash
cd /Users/messingtomas/Taher/hozan-taher/services/garaaage-worker
pnpm test
```

Verification status:

- `pnpm test` was verified locally on `2026-04-04`
- the service currently has the cleanest confirmed test pass in this stabilization batch

## Required Environment

Core runtime dependency:

- `REDIS_URL`

Other important runtime inputs visible in code:

- `WORKER_CONCURRENCY`
- `SENDGRID_API_KEY`
- `SENDGRID_FROM_EMAIL`
- `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`
- `FIREBASE_STORAGE_BUCKET`
- `MCP_REMOTE_URL`
- `MCP_REMOTE_SECRET`
- `ANTHROPIC_API_KEY`
- `LOG_LEVEL`
- `LOKI_URL`

## Documentation

### Canonical SpecKit Surface

Use these as the active truth for the service:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-worker/README.md)
  - service identity, worker pipeline, run/test entrypoints, environment, runtime notes, and known gaps

Interpretation rule:

- if future notes or reports disagree with the README, reconcile toward the README until a real additional documentation surface is explicitly introduced

### Reference Surface

These are useful, but they are not service documentation truth surfaces:

- [SPECKIT-DOC-MAP.md](/Users/messingtomas/Taher/hozan-taher/services/garaaage-worker/SPECKIT-DOC-MAP.md)
- [package.json](/Users/messingtomas/Taher/hozan-taher/services/garaaage-worker/package.json)
- [worker/index.ts](/Users/messingtomas/Taher/hozan-taher/services/garaaage-worker/worker/index.ts)
- [worker/queue.ts](/Users/messingtomas/Taher/hozan-taher/services/garaaage-worker/worker/queue.ts)
- [Dockerfile](/Users/messingtomas/Taher/hozan-taher/services/garaaage-worker/Dockerfile)

Use the reference surface for:

- document role classification
- implementation lookup
- worker runtime inspection

### Key Canonical Docs

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Service identity, run/test surface, env, runtime notes, and gaps |
| [package.json](package.json) | Script surface and dependency definition |
| [worker/index.ts](worker/index.ts) | Main worker entrypoint |
| [worker/queue.ts](worker/queue.ts) | Queue wiring and job runtime |
| [Dockerfile](Dockerfile) | Container build/runtime definition |

## Runtime Notes

- startup fails without `REDIS_URL`
- LibreOffice is part of the container/runtime expectation because PDF generation depends on it
- this service looks production-relevant and should not be treated as throwaway tooling

## Known Gaps

- no changelog yet
- no ADR yet
- no dedicated deployment/runbook document yet
