# Subsystem Map — Worker (Rozporuj PDF Generator)

**Version:** 2026-05-02
**Owner:** features/platform/worker
**Last verified:** 2026-05-02 (no code changes since 2026-05-01; commit 586fbda4)
**Refresh:** 2026-05-02 G5.2 header sync

`features/platform/worker` is a standalone TypeScript/Node.js BullMQ worker service deployed on Railway. It consumes jobs from the `rozporuj-pdf` queue and generates legal objection documents (odpor/rozklad) for the Rozporuj.com product. It is **separate** from `features/acquisition/scrapers`; the two services do not share a queue.

> **Mandatory read:** before modifying the job processing pipeline, adding job types, or changing the Firebase/email/PDF flow.

## Components

| Component | File | Role |
|-----------|------|------|
| Boot | `features/platform/worker/worker/index.ts:243` | Creates Redis connection, starts `Worker`, installs signal handlers |
| `processJob` | `features/platform/worker/worker/index.ts:56` | Main job handler: idempotency check → download → generate → convert → upload → email |
| `maybeShortCircuit` | `features/platform/worker/worker/index.ts:36` | H7 idempotency: checks Firebase for existing `results/<sessionId>/odpor.pdf` |
| `generateOdpor` | `features/platform/worker/worker/generate-odpor.ts` | Claude API agentic loop + MCP tool calls → markdown |
| `markdownToDocx` | `features/platform/worker/scripts/lib/docx-writer.ts` | Markdown → DOCX buffer |
| `docxToPdf` | `features/platform/worker/worker/pdf.ts` | DOCX → PDF via LibreOffice headless |
| `downloadFiles` / `uploadResults` / `uploadFile` / `fileExists` / `getSignedUrl` | `features/platform/worker/worker/firebase.ts` | Firebase Storage operations |
| `sendResultEmail` | `features/platform/worker/worker/email.ts` | SendGrid delivery to end user |
| `runShutdown` | `features/platform/worker/worker/index.ts:157` | Ordered graceful shutdown: health server → BullMQ drain → Redis quit → MCP release |
| `installProcessHandlers` | `features/platform/worker/worker/index.ts:221` | SIGTERM/SIGINT + uncaughtException/unhandledRejection handlers |
| Health server | `features/platform/worker/lib/health.ts` | GET `/healthz` on `HEALTH_PORT` (default 8090) |
| Sentry init | `features/platform/worker/worker/sentry.ts` | Sentry error capture |
| Queue definition | `features/platform/worker/worker/queue.ts` | `QUEUE_NAME = 'rozporuj-pdf'`; `PdfJobData` + `PdfJobResult` types |

## Job flow

```
BullMQ job 'rozporuj-pdf' dequeued
  → maybeShortCircuit(sessionId)           // check Firebase results/<sessionId>/odpor.pdf
      → already exists: re-send email, return  // H7 idempotency
  → downloadFiles(sessionId)               // Firebase Storage → in-memory files[]
  → generateOdpor(files, opts, log)        // Claude API + MCP tools → { markdown, conversationLog }
  → markdownToDocx(markdown, title, opts)  // → docxBuffer
  → docxToPdf(docxBuffer)                  // LibreOffice headless → pdfBuffer
  → uploadResults(sessionId, pdf, docx)    // Firebase → { outputPath, downloadUrl, docxUrl }
  → uploadFile('results/<id>/conversation.md', ...)
  → sendResultEmail({ to, firstName, downloadUrl, docxUrl })
  → return PdfJobResult
```

Source: `features/platform/worker/worker/index.ts:56-123`

## Queue definition

| Field | Value |
|-------|-------|
| Queue name | `rozporuj-pdf` |
| Connection | `REDIS_URL` (required, no fallback) |
| Concurrency | `WORKER_CONCURRENCY` env (default 2) |
| Rate limiter | max 10 jobs per 60s |
| `removeOnComplete` | `{ count: 100 }` — M6 Redis memory guard |
| `removeOnFail` | `{ count: 200 }` — M6 Redis memory guard |
| Per-job budget | `WORKER_MAX_ITER_BUDGET_MS` (default 300,000ms = 5min) |

Source: `features/platform/worker/worker/index.ts:127-141`, `worker/queue.ts`

## PdfJobData shape

```typescript
interface PdfJobData {
  sessionId: string;      // Firebase Storage path prefix + idempotency key
  email: string;          // recipient address for result delivery
  firstName: string;
  lastName: string;
  fileUrls: string[];     // Firebase URLs of uploaded PDF documents
  stripeSessionId: string;
  prompt?: string;        // optional operator override
  userNotes?: string;
}
```

Source: `features/platform/worker/worker/queue.ts:5-16`

## Shutdown sequence

Order (H1/H5 — bounded by `SHUTDOWN_TIMEOUT_MS` default 30s):

1. Close health HTTP server
2. `worker.close()` — drain in-flight jobs (BullMQ waits for active jobs)
3. `connection.quit()` — Redis QUIT + server ack
4. `closeMcp()` — release MCP singleton

On timeout → force exit(1). Source: `features/platform/worker/worker/index.ts:157-218`

## Public API

| Surface | Endpoint | Description |
|---------|----------|-------------|
| Health | `GET /healthz` | `{ status, uptime_seconds, service: "worker", timestamp }` |
| Job queue | `rozporuj-pdf` BullMQ queue | Producer is Rozporuj.com frontend (not in this repo) |

## Dependencies

| Dependency | What is consumed |
|------------|-----------------|
| `REDIS_URL` | BullMQ + ioredis connection (required) |
| `ANTHROPIC_API_KEY` | Claude API in `generateOdpor` |
| `MCP_REMOTE_URL` + `MCP_REMOTE_SECRET` | Railway MCP server for legal tools |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Base64-encoded Firebase credentials |
| `FIREBASE_STORAGE_BUCKET` | Firebase Storage bucket |
| `SENDGRID_API_KEY` | Email delivery |
| `WORKER_CONCURRENCY` | Worker parallelism (default 2) |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | Graceful shutdown budget (default 30s) |
| `HEALTH_PORT` | Health server port (default 8090) |
| LibreOffice headless | DOCX→PDF conversion |

## Relationship to other services

- **Not connected to** `features/acquisition/scrapers` — different queue, different domain
- **Not connected to** `features/inbound/orchestrator` — no shared DB tables, no shared queue
- **Reads from** `features/acquisition/scrapers` MCP server for legal knowledge (`judikaty`, `esbirka` tools)
- **Producer is** Rozporuj.com frontend (external to this repo) — pushes to `rozporuj-pdf` queue

## Open questions (unresolved as of 2026-05-01)

1. **`generateOdpor` MCP client** — is the MCP connection per-job or a process-level singleton? `closeMcp()` in shutdown suggests singleton; concurrency=2 means two jobs could share one MCP connection.
2. **Firebase credential rotation** — `FIREBASE_SERVICE_ACCOUNT_JSON` is base64-encoded at boot; no hot-reload path documented.
3. **LibreOffice availability** — `docxToPdf` assumes LibreOffice on `$PATH`; Docker image must include it. Not verified from Dockerfile.

## Cross-references

- Memory: `project_dockerized_lockfiles.md` — `features/platform/worker` has own `pnpm-lock.yaml`
- CLAUDE.md: `features/platform/worker/CLAUDE.md`
- Initiative: `docs/initiatives/2026-05-01-codebase-awareness-discipline.md`
- Issue: #560
