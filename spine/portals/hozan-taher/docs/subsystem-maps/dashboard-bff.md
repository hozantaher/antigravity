# Subsystem Map — Dashboard BFF (Express HTTP Surface)

**Refresh:** 2026-05-02 @ 22de816d
**Version:** 2026-05-01 (decomposition complete; local-dev cutover in progress)
**Owner:** features/platform/outreach-dashboard/server.js + src/server-routes/ + package.json scripts
**Last verified:** 2026-05-02 via read of server.js (boot + mounts), .env.example, mounter modules, mount call lines

`features/platform/outreach-dashboard/server.js` (7469 lines post-decomp) is the Express 5 BFF that serves the React dashboard. Most `/api/*` endpoints talk directly to PostgreSQL. A small subset proxy state-changing campaign lifecycle calls to the Go outreach backend (`GO_SERVER_URL`) with `x-api-key` authentication. Boot-time schema parity check and invariant validation run against Go's `/schema` endpoint.

**Local-dev deployment (as of 2026-05-01):** BFF no longer runs on Railway. Local execution only via `pnpm dev:full` on operator's Mac. Railway service (`outreach-dashboard`) deleted after cutover complete.

> **Mandatory read:** before adding a new BFF endpoint, modifying the Go proxy routes, or changing the boot-time schema check logic. Cite this map's commit SHA in PR description.

## Module structure

As of 2026-05-02 decomposition (ADR-008) is complete. All 12 mounter modules extracted; no endpoints remain inline in server.js (except static routes like `/healthz`, `/sentry-tunnel`).

| Module | File | Mount point | Mount line |
|--------|------|-------------|-----------|
| `mountPrivacyRoutes` | `src/server-routes/privacy.js` | `/privacy/*` | 249 |
| `mountUnsubscribeRoutes` | `src/server-routes/unsubscribe.js` | `/unsubscribe` | 336 |
| `mountDsrRoutes` | `src/server-routes/dsr.js` | `/api/dsr/*` | 343 |
| `mountMorningReadinessRoutes` | `src/server-routes/morningReadiness.js` | `/api/readiness/*` | 348 |
| `mountAnonymityRoutes` | `src/server-routes/anonymityLatest.js` | `/api/anonymity/*` | 353 |
| `mountOperatorMetricsRoutes` | `src/server-routes/operatorMetrics.js` | `/api/metrics/*` | 360 |
| `mountCompaniesRoutes` | `src/server-routes/companies.js` | `/api/companies/*` | 459 |
| `mountSegmentsRoutes` | `src/server-routes/segments.js` | `/api/segments/*` | 1546 |
| `mountCampaignsRoutes` | `src/server-routes/campaigns.js` | `/api/campaigns/*` | 1700 |
| `mountMailboxRoutes` | `src/server-routes/mailboxes.js` | `/api/mailboxes/*` | 1961 |
| `mountHealthRoutes` | `src/server-routes/health.js` | `/api/health/*` | 2187 |
| `mountLeadsRoutes` | `src/server-routes/leads.js` | `/api/leads/*` | 5088 |
| `mountRepliesRoutes` | `src/server-routes/replies.js` | `/api/replies/*` | 7082 |
| `mountBulkPasswordRoute` | `src/server-routes/bulkPassword.js` | `/api/bulk-password/*` | (wired, line not confirmed) |
| `mountTemplatePreviewRoute` | `src/server-routes/templatePreview.js` | `/api/template-preview/*` | (wired, line not confirmed) |

Source: server.js lines 50–64 (imports); mount calls verified at each line above.

## BFF → Go proxy routes

Only these routes forward to `GO_SERVER_URL` with `x-api-key: ${OUTREACH_API_KEY}`:

| BFF endpoint | Go endpoint | Fallback behavior |
|-------------|-------------|-------------------|
| `POST /api/campaigns` | `POST /api/campaigns` | Direct-DB INSERT (no enrollment) if Go unreachable; `_warning` in response |
| `POST /api/campaigns/:id/run` | `POST /api/campaigns/:id/run` | Status flip to `running` in Postgres |
| `POST /api/campaigns/:id/pause` | `POST /api/campaigns/:id/pause` | Status flip to `paused` in Postgres |
| `GET /api/__schema-check` | `GET /schema` | Compares live Go schema manifest vs frozen `schema-manifest.json`; cached `SCHEMA_CHECK_TTL_MS` (60s) |

Source: `CLAUDE.md` proxy table, `server.js:1761-1782`, `server-routes/campaigns.js:1-50`

## bootSchemaCheck + Boot invariants

At boot (before first request), `server.js` runs:

1. `bootSchemaCheck()` — calls Go's `/schema`, compares with frozen `schema-manifest.json`
2. `runBffBootInvariants()` — calls Go's `/health` for readiness signal

Source: `CLAUDE.md` architecture section

## In-memory read-through caches

| Cache | TTL | What it caches |
|-------|-----|----------------|
| Schema check | `SCHEMA_CHECK_TTL_MS = 60_000` (1min) | `GET /schema` response | `server.js:1727`  |
| Proxy pool | `PROXY_TTL = 15_000` (15s) | Anti-trace relay proxy pool snapshot | `server.js:2414` |
| Egress debug | `EGRESS_DEBUG_TTL_MS = 60_000` (1min) | Egress mode debug info | `server.js:2603` |
| Category tree | `CAT_TREE_TTL = 90_000` (90s) | Category tree nodes | `server.js:1439` |
| Category search | `CAT_SEARCH_TTL = 60_000` (1min) | Category search results | `server.js:1470` |
| Facets | `FACETS_TTL_MS = 30_000` (30s) | Facet counts | `server.js:402` |
| Lookalike | `LOOKALIKE_CACHE_MS = 30 * 60 * 1000` (30min) | Lookalike company sets | `server.js:1054` |
| Domain cache | `DOMAIN_CACHE_TTL_MS = 30 days` | Per-domain enrichment cache | `server.js:456` |

## Key endpoint catalogue

### Campaigns (src/server-routes/campaigns.js)

| Method | Path | Backend |
|--------|------|---------|
| GET | `/api/campaigns` | Direct PG |
| POST | `/api/campaigns` | Go proxy (fallback: direct PG) |
| GET | `/api/campaigns/:id` | Direct PG |
| GET | `/api/campaigns/:id/sends` | Direct PG |
| GET | `/api/campaigns/:id/preflight` | Runs `computeCampaignPreflight` |
| POST | `/api/campaigns/:id/send-test` | Anti-trace relay (not direct SMTP) |
| GET | `/api/campaigns/:id/estimate` | Direct PG |
| GET | `/api/campaigns/:id/best-time` | Direct PG |
| GET | `/api/campaigns/:id/inbox-placement` | Direct PG |
| GET | `/api/campaigns/:id/email-quality` | Direct PG |
| GET | `/api/campaigns/:id/capacity` | Direct PG |
| POST | `/api/campaigns/:id/run` | Go proxy (fallback: direct PG) |
| POST | `/api/campaigns/:id/pause` | Go proxy (fallback: direct PG) |
| POST | `/api/campaigns/:id/reset-next-send-at` | Direct PG — requires `confirm:true` + `reason≥10` |
| PATCH | `/api/campaigns/:id` | Direct PG |
| DELETE | `/api/campaigns/:id` | Direct PG |

### Health (src/server-routes/health.js)

| Method | Path | Data source |
|--------|------|-------------|
| GET | `/api/health/invariants` | `synthetic_runs` table |
| GET | `/api/health/cron-heartbeats` | `cron_heartbeats` table; stale flag = age > 2× expected interval |
| GET | `/api/health/test-quality` | `hallucination-score.json` file |
| GET | `/api/health/system` | `getProxyPool()` + `watchdog_events` table |
| GET | `/api/health/watchdog` | `watchdog_events` table |
| GET | `/api/health/auth-fail-alerts` | `watchdog_events` JOIN `outreach_mailboxes` |
| GET | `/api/health/proxy-exhaust` | `watchdog_events` WHERE `check_name = 'proxy_reassign_exhausted'` |
| GET | `/api/health/guards` | In-memory `lastStaleGuardRun` state |
| GET | `/api/health/drift` | `runConfigDrift()` (5min cache) |

`CRON_EXPECTED_INTERVAL_MS` map defines expected cadence per cron name; stale = age > 2×. Source: `health.js:34-46`

### DSR (src/server-routes/dsr.js)

GDPR Article 15 (access) + Article 17 (erasure). 8-table aggregate read/cascade write. Audit-logged.

### Unsubscribe (src/server-routes/unsubscribe.js)

HMAC token verification via `token.VerifyUnsubToken` JS twin, then inserts into both suppression tables.

### Proxy pool / Anti-trace

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/proxy-pool` | `getProxyPool()` — fetches from relay, 15s cache |
| GET | `/api/anti-trace/health` | Relay `/v1/health` bridge status; 60s cache |
| GET | `/api/anti-trace/egress` | Relay egress debug info; 60s cache |

Source: `server.js:2511-2606`

## Auth and middleware

- `X-API-Key` middleware: most `/api/*` endpoints require the header matching `OUTREACH_API_KEY`. Exemptions: `/unsubscribe`, `/healthz`, DSR public endpoints.
- CORS: `CORS_ORIGIN` env (comma-list, default `http://localhost:18175`)
- Idempotency: `Idempotency-Key` header tracked with `IDEMPOTENCY_TTL_MS = 10min` (server.js:297)

## Health store (frontend)

`useOutreachHealth` Zustand store (`src/store/outreachHealth.ts`) — consumers flip `degraded=true` when Go backend is unreachable. Store does not poll; individual page components trigger checks on mount.

## Environment

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `3100` | Express BFF port (local: `pnpm dev:full` exposes on 18001) |
| `GO_SERVER_URL` | `http://localhost:8080` | Go outreach backend (local: `modules/outreach` service) |
| `OUTREACH_API_KEY` | — | Forwarded to Go as `x-api-key`; guards BFF endpoints |
| `CORS_ORIGIN` | `http://localhost:5175` | Allowed CORS origin(s); local Vite dev usually on 18175 |
| `DATABASE_URL` | — | PostgreSQL connection string (local: Railway TCP proxy; prod: Railway-native) |
| `NODE_ENV` | `development` | Set to `production` for prod builds/Railway deploy |
| `SENTRY_DSN_BFF` | — | Sentry error monitoring (optional) |

**Local-dev note:** `.env.example` specifies 3100 (standard), but `pnpm dev:full` runs both Vite (18175) and BFF (18001) in parallel. See root `package.json` scripts.

## Cron jobs status

As of 2026-04-29 the BFF cron jobs are **dormant** because the operator's Mac (local-dev host) is not guaranteed to run 24/7. Affected crons:
- `runFullCheckCron` — moved to Go orchestrator (CAD-S8, issue #539)
- 13 additional crons in BFF — now dormant pending S3 migration

**Re-activation:** Crons will resume either (1) via long-running Railway service re-deployment, or (2) scheduled cleanup PR (tentative 2026-05-15) when infrastructure stability confirmed. See `docs/initiatives/2026-05-02-post-cleanup-hardening.md#sprint-s3` for roadmap.

**Data consistency:** Dormant crons do not affect correctness; read-heavy endpoints still call the underlying functions on-demand. Missing heartbeats in `cron_heartbeats` table are flagged by `/api/health/cron-heartbeats` endpoint.

## Deployment

**Local (development, as of 2026-05-01):**
- No Railway service for `outreach-dashboard` BFF
- Run via `pnpm dev:full` on operator's Mac (starts Vite :18175 + BFF :18001)
- Requires local Go service (`modules/outreach` on :8080)
- See `docs/handoff/bootstrap-dev.md` for multi-worktree orchestration

**Production (legacy, historical reference):**
- Previous Railway service `outreach-dashboard` has been decommissioned
- No active production BFF deployment as of 2026-05-02
- Go backend (`modules/outreach`) remains on Railway as primary service

## Cross-references

- Anti-trace map: `docs/subsystem-maps/anti-trace.md` — BFF consumes `/v1/proxy-pool`, relay health + egress
- Memory: `project_system_report_tool.md` — `pnpm report` unified diagnostic
- Codebase awareness: `docs/initiatives/2026-05-02-post-cleanup-hardening.md` — S2–S4 sprint plan
- CLAUDE.md: `features/platform/outreach-dashboard/CLAUDE.md` — stack + scripts + env vars
- ADR-008: server.js decomposition initiative (complete as of 2026-05-02)
- Issue: #560 (CAD-A1 subsystem maps), #614 (server.js decomposition sprint)
