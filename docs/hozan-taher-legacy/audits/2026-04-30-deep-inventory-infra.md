# Deep Inventory — Infrastructure (2026-04-30)

## Executive Summary

**Services:** 8 deployed on Railway
**Migrations:** 19 sequenced SQL migrations (000–019) + bookkeeping + run.sh enforcement
**Env vars (Go):** 102 unique references across services
**Env vars (Node/Dashboard):** 52 unique references in features/platform/outreach-dashboard
**CI Workflows:** 14 GitHub Actions workflows
**Cron jobs (BFF):** 8+ named timed() intervals
**Health endpoints:** 6 of 8 services declare healthcheck path + timeout
**DB tables:** 20+ schema tables via migrations (see audit_log variants, leads, enrichment, attachments, staircase config, classifier overrides)

---

## Railway Services Catalog

| Service | Dockerfile | Health Path | Health Timeout | Restart Policy |
|---------|-----------|-------------|---|---|
| **relay** | ✓ | `/healthz` | 30s | ON_FAILURE (max 3) |
| **mcp** | ✓ | `/health` | 30s | ON_FAILURE (max 3) |
| **worker** | ✓ | *none declared* | — | ON_FAILURE (max 3) |
| **orchestrator** | ✓ | `/healthz` | 300s | ON_FAILURE (max 3) |
| **anti-trace-relay** | ✓ | `/healthz` | 30s | ON_FAILURE (max 3) |
| **scrapers** | ✓ | *none declared* | — | ON_FAILURE (max 3) |
| **privacy-gateway** | ✓ | `/healthz` | 10s | ON_FAILURE (max 3) |
| **llm-runner** | ✓ | `/healthz` | 10s | ON_FAILURE (max 3) |
| **outreach-dashboard (BFF)** | ✓ | `/api/health` | 120s | ON_FAILURE (max 3) |

All services use `builder = "DOCKERFILE"` with local docker build config.

---

## Postgres Schema Overview

**Migrations applied:** 000 (bootstrap) through 019 (classifier_overrides)
**Bookkeeping table:** `schema_migrations` (id, migration_id, filename, content_sha256, applied_at, applied_by, git_sha)

### Key tables added via migrations:

| Table | Migration | Purpose |
|-------|-----------|---------|
| `schema_migrations` | 000 | Bookkeeping for numbered migration sequencing |
| *(removed)* `campaign_enrollments` | 001 | Cleaned up |
| `contacts` + `outreach_contacts` | Various | Legacy domain split (contacts vs outreach.contacts) |
| `mailbox_pool` | 006 | SMTP source pool (encrypted passwords) |
| `outreach_campaigns` | 017 (staircase) | Campaign sending with configured sequence + daily cap + staircase ramp |
| `outreach_messages` | 012 | Full message body storage (not just headers) |
| `message_attachments` | 013 | Message attachment tracking |
| `leads` | 009 | Prospect/lead records |
| `enrichment_log` | 015 | Third-party data enrichment calls + results |
| `cron_heartbeats` | 014 (refresh_cron_state) | Cron last-run tracking (per `timed()` name) |
| `campaign_lock_audit` | 007 | Advisory lock audit trail for campaign mutations |
| Audit log tables | 019 | `channel_audit_log`, `ai_suggestion_audit`, `photo_parse_audit` |

**Foreign keys & cascade:** Per migrations doc — see `scripts/migrations/` for exact DDL.

**Indexes:** Migrations create indexes on commonly-filtered columns (status, created_at, campaign_id, contact_id).

---

## Cron Jobs Catalog (BFF - features/platform/outreach-dashboard)

All wrapped via `timed(name, fn)` function in `server.js` (emits `[cron] <name> duration_ms=<n>` post-completion).

| Job | Interval | Trigger | Purpose |
|-----|----------|---------|---------|
| `runFullCheckCron` | 4h | Boot + setInterval | Full mailbox health check (SMTP probes, greylisting, throttle) |
| `runStaleHealthCheckCron` | 60s | Boot + setInterval | Detect stale mailbox states, update status cache |
| `runImapPollCron` | 15m | Boot + setInterval | Fetch + classify inbound replies from IMAP |
| `runDailyMetricsTick` | Hourly | Boot + setInterval | Compute dashboard KPI cache (CTR, bounce rate, pipeline age) |
| `emailReverifyWorker` | Every 10min (tunable) | Boot + setInterval | Reverify bounced contacts (batch, daily cap, SQL-driven) |
| `runConfigDriftCron` | 1h | Boot + setInterval | Detect campaign config changes vs live DB state |
| `runMailboxBounceThrottle` | 30s | Boot + setInterval | Enforce bounce rate limits + auto-pause thresholds |
| `runBootInvariants` | Boot only | app.listen | Verify schema parity + /schema endpoint health + migration state |

**State tracking:** Stored in `cron_heartbeats` table (last_run TIMESTAMPTZ per job name).

---

## Environment Variables Taxonomy

### Go Services (102 total env refs across services/*)

**Core database:**
- `DATABASE_URL` — PostgreSQL connection string
- `DATABASE_URL_TEST` — Test-only override
- `DB_HOST`, `DB_PASSWORD` — Legacy/split form (fallback if DATABASE_URL absent)

**Authentication & API keys:**
- `OUTREACH_API_KEY` — Shared secret for BFF ↔ Go calls (X-API-Key header)
- `ADMIN_TOKEN` — OAuth/admin bearer token validation
- `DEV_API_TOKEN` — Development-only bypass
- `DEV_MODE`, `DEV_TENANT_ID`, `DEV_USER_ID` — Dev mode flags

**Relays & egress:**
- `ANTI_TRACE_RELAY_URL`, `ANTI_TRACE_RELAY_TOKEN` — Privacy-hardened relay endpoint
- `TRANSPORT_MODE` — `proxy` (Mullvad WireGuard + SOCKS5) | `direct` (FORBIDDEN per memory)
- `SOCKS_PROXY_ADDR` — SOCKS5 proxy address (localhost:1080 for wireproxy)
- `WIREPROXY_CONFIG` — WireGuard config (multi-line ini)

**Encryption:**
- `DATA_ENCRYPTION_KEY_B64` — Base64 mailbox password encryption key
- `VAULT_ENCRYPTION_KEY_B64` — Separate vault for sensitive data

**Observability & alerts:**
- `SENTRY_DSN_BFF`, `SENTRY_TRACES_SAMPLE_RATE` — Error tracking (dashboard only)
- `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_SECRET` — Incident notifications
- `INVARIANT_SAMPLE_RATE`, `INVARIANT_THROW` — Invariant violation sampling

**LLM & external APIs:**
- `ANTHROPIC_API_KEY` — Claude API for reply classification
- `LLM_ENDPOINT`, `LLM_MODEL`, `LLM_PROVIDER` — Override for local inference

**Operational flags:**
- `DISABLE_CAMPAIGN_DAEMON` — Skip sender loop
- `DISABLE_IMAP_POLL` — Skip reply fetch
- `DISABLE_PROTECTION_PROBES` — Skip IP geolocation checks
- `APP_ENV` — Environment name (dev | staging | prod)

### Node/Dashboard (52 total env refs in features/platform/outreach-dashboard/)

**Server (Express BFF):**
- `PORT` — BFF listen port (default 18001)
- `GO_SERVER_URL` — Go backend address (http://localhost:8080)
- `OUTREACH_API_KEY` — Same shared secret as Go services
- `CORS_ORIGIN` — Comma-separated frontend origins
- `BFF_AUTH_DISABLED` — Skip auth middleware (dev only)
- `BFF_RATE_LIMIT_DISABLED` — Skip rate limit checks
- `BFF_AUTO_RECOVER` — Auto-reconnect on Go failure
- `BFF_IMPORT_ONLY` — Skip campaign send gates

**Database:**
- `DATABASE_URL` — PostgreSQL (direct from BFF)

**Health & observability:**
- `SENTRY_DSN_BFF` — Dashboard-specific Sentry project
- `SKIP_ENDPOINT_INSTRUMENTATION` — Skip `/api/*` hit tracking
- `SKIP_SCHEMA_CHECK` — Skip DB schema parity checks
- `SKIP_BOOT_INVARIANTS` — Skip startup validation
- `INVARIANT_SAMPLE_RATE`, `INVARIANT_THROW` — Same as Go

**Feature flags:**
- `NO_CRON` — Disable all setInterval() jobs (dev testing)
- `FAULT_INJECT_ALLOWED` — Enable /api/__fault-inject endpoint
- `BFF_IMPORT_ONLY` — Only allow data imports (no campaign send)

**Testing & synthetic:**
- `SYNTHETIC_TARGET_URL` — Prod continuous monitoring endpoint
- `SSE_ENDPOINT` — Server-sent event endpoint for real-time dashboards
- `OPERATOR_PRACTICE_BINARY` — Path to practice bot binary (optional)
- `OPERATOR_PRACTICE_BATCH_SIZE` — Batch size for operator practice mode

**Lab/Dev:**
- `LAB_API`, `LAB_API_KEY` — Local lab backend
- `LAB_IMAP_USER`, `LAB_IMAP_PASS` — Test mailbox credentials

**Secrets (node-handled, NOT in Docker env):**
- `UNSUBSCRIBE_SECRET` — HMAC key for unsubscribe link generation

---

## CI Workflows & Failure Trends

**Total workflows:** 14 GitHub Actions files

| Workflow | Purpose | Trigger | Status |
|----------|---------|---------|--------|
| `go-services-ci.yml` | Go unit + integration tests | PR, push main | 📊 |
| `go-test-reusable.yml` | Reusable Go test matrix | Called by go-services | — |
| `dashboard-real-backend.yml` | BFF + React tests (live DB) | PR, push main | 📊 (a11y-gate job) |
| `node-services-ci.yml` | Node service tests (relay, mcp) | PR, push main | — |
| `mail-lab-ci.yml` | SMTP integration tests | Push main | — |
| `codeql.yml` | SAST (security scan) | Schedule, PR | 📊 |
| `mutation-testing.yml` | Stryker mutation test runner | PR | — |
| `test-health.yml` | Cron health check (post-merge) | Schedule | 📊 |
| `test-quality.yml` | Ratchet coverage + discipline | PR | 📊 |
| `merge-gate.yml` | Enforce status checks before merge | PR | — |
| `sentry-triage.yml` | Auto-triage prod errors | Schedule | — |
| `bot-worker.yml` | Autonomous bot (backlog worker) | Schedule | — |
| `daily-digest.yml` | Summary digest | Schedule | — |
| `reprioritize.yml` | Backlog reprioritization | Schedule | — |
| `triage-failures.yml` | CI failure classification | On failure | — |

**Skip patterns:** Not enumerated in this audit (static analysis only).

---

## Health & Observability Surface

### Health endpoints (per service)

- **relay, anti-trace-relay, orchestrator, privacy-gateway, llm-runner:** `/healthz` (30s-300s timeout)
- **mcp:** `/health` (30s timeout)
- **outreach-dashboard (BFF):** `/api/health` (120s timeout)
- **worker, scrapers:** No health endpoint declared (manual restart only)

### Sentry initialization

- **BFF (`server.js`):** `telemetry.Init("outreach-dashboard")` auto-detects `GIT_SHA` / `RAILWAY_GIT_COMMIT_SHA` / `SOURCE_COMMIT`, constructs release tag `outreach-dashboard@<sha>`
- **Dashboard React:** Likely initialized in `src/` (not enumerated here; check `sentry.server.js` import)

### Audit log writers (post #417 & #405)

Three audit tables created in migration 019:

1. `channel_audit_log` — Channel mutation events
2. `ai_suggestion_audit` — LLM suggestion acceptance/rejection
3. `photo_parse_audit` — Photo parsing attempt log

### Slog discipline (post-PR #405)

Every Go `slog.Error` / `slog.Warn` includes:
- `op` field: `<package>.<func>/<branch>` for call-site tracking
- `error` key (not `err`) for error messages
- Entity keys: `campaign_id`, `contact_id`, `mailbox_id` (not random names)

Audit test in `features/outreach/campaigns/sender/slog_op_audit_test.go` enforces maximum violation count (ratcheted downward over time).

---

## Notable Infrastructure Rules & Constraints

### Egress (HARD RULE)

- **Direct transport FORBIDDEN** (`TRANSPORT_MODE=direct` returns `ErrDirectTransportForbidden`)
- **Tor disabled** (interferes with WireGuard handshake on Railway)
- **Free proxy pool retired** (Czech SMTP servers reject public proxy IPs)
- **Only supported:** Mullvad WireGuard via SOCKS5 proxy (wireproxy → localhost:1080)

### Migration sequencing

- **Bookkeeping enforces predecessor ordering:** Operator cannot apply migration 003 before 001 (run.sh exits with code 3 if predecessor missing)
- **Drift detection:** SHA256 of applied migration file vs. DB record prevents accidental edits to applied migrations
- **Idempotent bootstrap:** schema_migrations table creation is safe to re-run

### Encryption

- **Mailbox passwords:** Encrypted via `DATA_ENCRYPTION_KEY_B64` (never hardcoded; must be env var)
- **Vault encryption:** Separate `VAULT_ENCRYPTION_KEY_B64` for additional sensitive data
- **Rotation:** Procedure defined in `docs/playbooks/secret-rotation.md` per secret (blast-radius listed)

### Campaign send gates

- **BFF preflight:** `computeCampaignPreflight()` validates pool + mailbox state before `/api/campaigns/:id/run`
- **Staircase enforcement:** Campaign.sequence_config default + daily cap ramp (migration 017)
- **Auto-pause triggers:** shouldAutoPause() + bounce-rate thresholds + greylisting detection

---

## Recommendations

1. **Worker & Scrapers healthcheck:** Add `/health` or `/healthz` endpoints to match relay/mcp/orchestrator pattern (supports Railway automatic restart verification)

2. **Cron heartbeat query:** Verify `cron_heartbeats` table backfill (created in 014) — any jobs failing silently between heartbeat inserts will appear as stale

3. **Slog discipline audit:** `slog_op_audit_test.go` maximum violations count is a ratchet — monitor that weekly to catch new violations early

4. **Schema drift checks:** Run `SCHEMA_CHECK_TTL_MS` cache busting every 24h in staging to catch applied-but-not-recorded migrations before prod

5. **CI skip patterns:** Full enumeration of `.github/workflows/*/if: ...` conditions recommended for next audit (captures which jobs run on forks, drafts, renovate PRs)

---

**Report Generated:** 2026-04-30  
**Codebase:** /Users/messingtomas/Documents/Projekty/Hozan-Taher (main branch snapshot)  
**Branch for commit:** `audit/inventory-infra-2026-04-30` (base=main)
