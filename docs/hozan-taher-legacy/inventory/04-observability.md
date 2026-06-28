# Inventory: Observability + Healing Log

Comprehensive map of observability, alerting, and healing log infrastructure supporting production monitoring, operator dashboards, and auto-recovery.

---

## 1. Sentry Integration (Error Capture & Cron Monitoring)

### Core Init & Release Tagging
| File | Purpose |
|------|---------|
| `features/platform/common/telemetry/sentry.go:66-90` | `Init(service)` — initializes Sentry from `SENTRY_DSN_GO` env var; reads `APP_ENV` for environment tag |
| `features/platform/common/telemetry/sentry.go:98-111` | `BuildReleaseTag(service)` — creates `<service>@<sha>` tag from GIT_SHA/RAILWAY_GIT_COMMIT_SHA/SOURCE_COMMIT (7-char trim) |
| `features/platform/common/telemetry/sentry.go:235-243` | `SetServiceTag(name)` — sets `service` tag + `service.version` from `APP_VERSION` env |

### Sentry Integration Points per Service
- **Orchestrator** (`features/inbound/orchestrator/cmd/outreach/main.go:52-56`): Calls `telemetry.Init("outreach")` + `SetServiceTag("outreach")` + wires slog→Sentry bridge
- **Relay** (`features/outreach/relay/cmd/relay/main.go`): Uses stdlib-only logging (no Sentry)
- **Privacy Gateway** (`features/compliance/privacy-gateway/cmd/privacy-gateway/main.go`): Uses stdlib-only logging

### Cron Monitoring & Check-ins
| File | Purpose |
|------|---------|
| `features/platform/common/telemetry/sentry.go:14-64` | `MonitoredJob(slug, fn)` — wraps cron job with Sentry check-in lifecycle (in_progress → ok/error); recovers panics; active only when `SENTRY_DSN_GO` is set |
| `features/platform/common/telemetry/cron_test.go` | 8 test cases: success, error propagation, panic recovery, nil fn safety |

### slog to Sentry Bridge
| File | Purpose |
|------|---------|
| `features/platform/common/telemetry/sentry.go:118-165` | `SlogHandler` — wraps existing slog.Handler; forwards all `slog.LevelError` records to Sentry; captures attrs as `slog_attrs` context |
| `features/inbound/orchestrator/cmd/outreach/main.go:58-59` | Wire: `slog.SetDefault(slog.New(telemetry.NewSlogHandler(...)))` |

### Emergency Exit with Sentry Flush
| File | Purpose |
|------|---------|
| `features/platform/common/telemetry/sentry.go:113-116` | `Flush()` — blocks up to 2s draining queue before exit |
| `features/platform/common/telemetry/sentry.go:167-178` | `FatalExitFn(err, code)` — captures err, flushes, calls `os.Exit(code)` |

### HTTP Middleware
| File | Purpose |
|------|---------|
| `features/platform/common/telemetry/sentry.go:180-202` | `HTTPRecoveryMiddleware` — recovers panics in handlers, captures in Sentry, returns 500 |
| `features/platform/common/telemetry/sentry.go:212-231` | `TracedHTTPMiddleware` — creates Sentry transaction span per HTTP request (when `SENTRY_DSN_GO` set); spans tagged `http.server` |

---

## 2. Prometheus Metrics (Timeseries Exposition)

### Metrics Registry & Types
| File | Purpose |
|------|---------|
| `features/platform/common/metrics/metrics.go:1-45` | Package docs + `Counter`, `Gauge` structs; stdlib-only implementation (no prometheus/client_golang); exposition format per Prometheus text spec |
| `features/platform/common/metrics/metrics.go:72-80` | `NewCounter(name, help)` + `NewGauge(name, help)` — register into global `counters`, `gauges` slices (thread-safe) |
| `features/platform/common/metrics/metrics.go` | `LabeledGauge`, `LabeledCounter` — per-label-set values (e.g., `outreach_circuit_domain_open{domain=...}`) |

### HTTP /metrics Handler
| File | Purpose |
|------|---------|
| `features/inbound/orchestrator/web/server.go:68` | `http.Handle("/metrics", metrics.Handler())` — exposes Prometheus text format on `GET /metrics` |
| `features/platform/common/metrics/metrics.go:100+` | Handler marshals counters + gauges + labeled variants in alphabetical order per Prometheus spec |

### Outreach-Domain Metrics
| File | Purpose |
|------|---------|
| `features/platform/common/metrics/outreach.go` | 20+ metrics defined; registered once at package init; labels include domain, layer, level, address, status, signal_type |

**Send Pipeline:**
- `SendTotal` — all SMTP attempts
- `SendSuccessTotal` — SMTPOK outcomes
- `SendBounceTotal` — permanent 5xx
- `SendGreylistedTotal` — transient 4xx

**Queuing:**
- `QueueDepth` — current sender queue size (updated per tick)

**Circuit Breaker:**
- `CircuitGlobalOpen` — 1 if global breaker tripped
- `CircuitDomainOpen{domain}` — 1 per domain currently open

**Bounce Rate:**
- `BounceRate` — rolling bounce rate (0.0–1.0) in current hourly window

**Per-Mailbox Health** (refreshed each intelligence cycle):
- `MailboxStatus{address}` — 1=active, 2=paused, 3=bounce_hold, 4=retired
- `MailboxConsecutiveBounces{address}`
- `MailboxCanaryRemaining{address}`
- `MailboxCircuitOpen{address}`

**Intelligence Loop:**
- `IntelLoopTotal` — completed cycles
- `IntelLoopFailTotal` — failed/panicked cycles
- `IntelLoopDurationMs` — last cycle duration
- `IntelScoresRecalculated` — recalc count in last cycle
- `IntelCompaniesClassified` — LLM classifications in last cycle

**Protection Probes** (labeled by layer, level, status):
- `ProbeRunTotal` — runs by outcome
- `ProbeLatencyMs` — most recent latency
- `ProbeAlertOpen` — 1 if alert exists for (layer, level)

---

## 3. Health Endpoints

### Orchestrator /health Endpoint
| File | Purpose |
|------|---------|
| `features/inbound/orchestrator/web/server.go:70` | `GET /health` — returns daemon health registry + optional surfaces |
| `features/platform/common/health/health.go` | `Registry` struct tracks daemon status by name (OK flag, last_run, error); thread-safe |
| `features/platform/common/health/health.go:32-41` | `Report(name, ok, errMsg)` — records daemon tick outcome (called by daemon goroutines periodically) |
| `features/platform/common/health/health.go:44-65` | `Snapshot()` returns copy of all daemon statuses; `AllOK()` flips overall health |

**Optional Surfaces** (via `WithHealthSurfaces` in main.go):
- `stale_advisory_lock_ids: []int64` — campaign IDs with locks past TTL (flips status to degraded if non-empty)
- `pending_envelopes: int` — anti-trace-relay queue backpressure signal
- `greylist_queue_depth: int` — `email_verify_queue` rows due before now

### BFF Health API Routes
| Endpoint | File | Purpose |
|----------|------|---------|
| `GET /api/health/invariants` | `server.js:2846-2875` | Latest synthetic-smoke run + age_min + stale flag (5min threshold); checks synthetic_runs table |
| `GET /api/synthetic-runs` | `server.js:2878-2915` | Query endpoint for Observability.jsx; returns last N runs with pass/fail counts; stats (total, avg_duration_ms) |
| `GET /api/health/cron-heartbeats` | `server.js:2917-2941` | Returns cron_heartbeats table: cron_name, last_run_at, last_duration_ms, last_status, last_error |
| `GET /api/health/test-quality` | `server.js:2943-2956` | Reads `hallucination-score.json` from disk (BFF module dir); LLM output quality metrics |
| `GET /api/health/system` | `server.js:2961-2998` | Merges proxy-pool + watchdog state; alerts on proxy_pool_low; watchdog_stale if last event >15min old |
| `GET /api/health/watchdog` | `server.js:3006-3033` | Last event timestamp + staleness check + 24h event type breakdown; gracefully handles missing table |
| `GET /api/health/auth-fail-alerts` | `server.js:3049-3080` | Last 24h watchdog auth failure alerts (SMTP AUTH failures ≥3 in 15min window) |
| `GET /api/health/proxy-exhaust` | `server.js:3083-3127` | Latest protection_probes for proxy layer; burndown metrics |
| `GET /api/health/guards` | `server.js:3219-3261` | Protection layer guard stats; proto layer probes |
| `GET /api/health/drift` | `server.js:3263-3330` | Schema drift checks; structural invariants on contact schema |
| `GET /api/health/protections` | `server.js:3309-3330` | Protection alert state; open/acked alerts per layer |

---

## 4. Healing Log + Watchdog Events

### Healing Log Table & API
| File | Purpose |
|------|---------|
| `server.js:4225-4234` | Schema: `id`, `entity_type`, `entity_id`, `entity_label`, `action`, `reason`, `resolved_at`, `created_at` + index on `created_at DESC` |
| `server.js:4431-4441` | `logHealing(entityType, entityId, entityLabel, action, reason)` — inserts into healing_log; catches/logs errors |
| `server.js:7139-7150` | `GET /api/healing/log` — returns last N healing events (limit ≤200) + total count |
| `server.js:7152-7167` | `GET /api/healing/stats` — action breakdown (7-day window) + count for last 24h |

**Healing Actions Logged:**
- `cap_reduced` — daily cap decreased on mailbox
- `bounce_pause` — mailbox paused due to sustained bounces
- `auto_pause` — automation triggered pause
- `auto_resume` — automation triggered resume (SMTP auth restored or bounce grace expired)
- `low_performance` — campaign performance fallen below threshold

### Watchdog Events Table & API
| File | Purpose |
|------|---------|
| `server.js:4250-4265` | Schema: `id`, `check_name`, `severity`, `entity_type`, `entity_id`, `message`, `auto_healed`, `healed_at`, `created_at`; evolved columns: `event_type`, `mailbox_id`, `reason`, `metadata` (JSONB) |
| `server.js:2747-2799` | Watchdog writers: `INSERT INTO watchdog_events (mailbox_id, event_type, auto_healed, reason, metadata)` during mailbox automation |
| `server.js:3006-3033` | `GET /api/health/watchdog` — last event timestamp, staleness (>15min), 24h type breakdown, healthy flag |

**Event Types in Watchdog:**
- `auth_fail_alert` — 3+ SMTP AUTH failures in 15min (metadata: fail_count, mailbox_id) → surfaces in AuthFailAlertBanner (AUTH_EXEMPT auth)
- `cap_reduced`, `bounce_pause`, `auto_pause`, `auto_resume` — mirrors healing actions

---

## 5. Logging Conventions

### "op" Field Discipline (BF-F2)
| File | Purpose |
|------|---------|
| `features/outreach/campaigns/sender/slog_op_audit_test.go` | **Discipline test**: every `slog.Error/Warn` in package must include `"op", "<package>.<func>/<branch>"` as FIRST keyed arg; ratcheting baseline = 5 violations allowed |
| `features/compliance/privacy-gateway/internal/inbox/slog_op_audit_test.go` | Same pattern enforced |
| `features/compliance/privacy-gateway/internal/httpapi/slog_op_audit_test.go` | Same pattern enforced |
| `features/acquisition/contacts/enrichment/slog_op_audit_test.go` | Same pattern enforced |

**Convention:**
- Format: `slog.Error("msg", "op", "sender.recordSendResult/transient", "key", value, ...)`
- Enables log search by operation (e.g., grep `"op":"db connection lost"`)
- Violations reported as ratcheting baseline; commits that lower it reduce the cap

### Error Key (not err)
- All slog calls use `"error", err` NOT `"err", err` — consistent for Sentry grouping

---

## 6. Synthetic Monitoring & Invariants

### Synthetic Runs Table & Execution
| File | Purpose |
|------|---------|
| `server.js:6858-6866` | Schema: `id`, `ran_at`, `suite`, `results` (JSONB), `pass_count`, `fail_count`, `duration_ms` |
| `server.js:6858-6880` | BFF cron: executes synthetic test suite, persists to `synthetic_runs`, captures failures in Sentry |
| `server.js:2878-2915` | `GET /api/synthetic-runs?limit=100` — for Observability.jsx status grid; returns runs with results |

### Invariants Endpoint
| File | Purpose |
|------|---------|
| `server.js:2846-2875` | `GET /api/health/invariants` — latest synthetic-smoke run + synthetic_age_min + stale flag (>5min) + generated_at timestamp |
| `features/platform/outreach-dashboard/src/pages/Observability.jsx` | Observability page: displays synthetic status grid, burn rate badge (14.4× = page, 6× = warn, 1× = caution), stats |

---

## 7. Protection Probes & Alerts

### Probe Recording & Metrics Sink
| File | Purpose |
|------|---------|
| `features/inbound/orchestrator/protections/probe/recorder.go:45-90` | `PGRecorder` — writes one Result row to `protection_probes` table; persists layer, level, status, latency_ms, expected/actual (JSONB) |
| `features/inbound/orchestrator/protections/probe/recorder.go:11-43` | `AlertingSink` — wraps inner Sink, calls `EvaluateLayer` out-of-band after successful Write; recovers evaluator panics |
| `features/inbound/orchestrator/protections/probe/metrics_sink.go` | `MetricsSink` — writes probe results to Prometheus `ProbeRunTotal`, `ProbeLatencyMs`, `ProbeAlertOpen` metrics |

### Protection Alerts Table
| File | Purpose |
|------|---------|
| `features/inbound/orchestrator/protections/alert/evaluator.go` | Alert evaluator: reads latest probes per (layer, level); compares against thresholds; UPSERTs `protection_alerts` (open/acked/resolved states) |
| `server.js:3550-3569` | `GET /api/health/protections` — returns latest alerts with open/acked/resolved status; ACK endpoint to mark as seen |
| Metrics: `ProbeAlertOpen{layer,level}` — 1 if alert exists, 0 otherwise |

---

## 8. Cron Heartbeat Monitoring

### Cron Heartbeat Table & Lifecycle
| File | Purpose |
|------|---------|
| `server.js:6698-6704` | Schema: `cron_name` (PK), `last_run_at`, `last_duration_ms`, `last_status` ('ok'/'error'), `last_error` |
| `server.js:6710-6712` | `startCronEngine()` — boot ensures `cron_heartbeats` table exists via `ensureCronHeartbeats()` |
| `server.js:6660-6690` | `timed(name, fn)` wrapper — UPSERT heartbeat after execution with status/duration/error |
| `server.js:2917-2941` | `GET /api/health/cron-heartbeats` — returns all cron names + last status + error (if any) |

**Crons Monitored:**
- proxy-pool-refresh (5min)
- intelligence-loop (6h)
- mailbox-automation (1h)
- campaign-watchdog (1h)
- all others wrapped via `timed()` helper

---

## 9. Audit Logging

### Operator Audit Log (Cross-Service)
| File | Purpose |
|------|---------|
| `features/platform/common/audit/log.go:21-50` | `Log(ctx, execer, action, actor, entityType, entityID, details)` — inserts into `operator_audit_log` + reads back row ID for tracking |
| `features/platform/common/audit/log.go:10-20` | `Execer` interface — accepts `*sql.DB` and `*sql.Tx` so callers control tx scope |
| Called from: campaign lock audit (BF-E4), DSR endpoints (BF-GDPR), contact import, contact enrichment |

**Key Audit Scenarios:**
- Campaign lock acquire/release (advisory lock lifecycle in `campaign_lock_audit`)
- DSR access request (Article 15) — 8-table aggregate read, audit-logged
- DSR erasure (Article 17) — cascade delete, audit-logged
- Operator actions on mailboxes, campaigns, contacts

---

## 10. Dashboard UI Components

### Observability Page
| File | Purpose |
|------|---------|
| `features/platform/outreach-dashboard/src/pages/Observability.jsx` | M5 — synthetic health page; displays burn-rate badge (severity levels), status grid (last 60 runs), test-quality card, invariants age |
| Uses: `/api/synthetic-runs`, `/api/health/invariants`, `/api/health/test-quality` |

### Watchdog Page
| File | Purpose |
|------|---------|
| `features/platform/outreach-dashboard/src/pages/Watchdog.jsx` | Displays healing log + watchdog events + auto-recovery status |
| Uses: `/api/healing/log`, `/api/healing/stats`, `/api/health/watchdog` |

### Health Stores & Banners
| File | Purpose |
|------|---------|
| `features/platform/outreach-dashboard/src/hooks/useOutreachHealth` | Zustand store; polls `/api/daemons` (GO backend); degraded flag triggers banner in Dashboard |
| `features/platform/outreach-dashboard/src/components/AuthFailAlertBanner` | AUTH_EXEMPT endpoint polls `/api/health/auth-fail-alerts`; displays mailbox auth failures during office hours |
| Dashboard banner: proxy-pool warning + watchdog staleness check via `/api/health/system` |

---

## 11. Key Tables for Observability

| Table | Primary Use | Updated By |
|-------|-------------|-----------|
| `healing_log` | Track auto-recovery actions (cap reduction, pause/resume) | BFF automation cron |
| `watchdog_events` | Event log for mailbox state changes + alerts | BFF watchdog cron |
| `synthetic_runs` | Continuous monitoring results (pass/fail per test suite) | BFF synthetic cron |
| `cron_heartbeats` | Cron execution status + timing | `timed()` wrapper in all crons |
| `protection_probes` | Network/security probe results (layer, level, latency) | Probe scheduler + PGRecorder |
| `protection_alerts` | Open/acked alerts from protection probes | Alert evaluator |
| `operator_audit_log` | Operator actions (DSR, campaign lock, imports) | audit.Log() calls |
| `campaign_lock_audit` | Advisory lock lifecycle for campaigns | Campaign scheduler |

---

## 12. Integration Points & Env Vars

### Sentry Config
- `SENTRY_DSN_GO` — enables Sentry client (optional; absence = no-op)
- `APP_ENV` — environment tag (dev, staging, prod)
- `GIT_SHA` / `RAILWAY_GIT_COMMIT_SHA` / `SOURCE_COMMIT` — release tag (7-char sha)
- `APP_VERSION` — service version tag

### Metrics Exposition
- `GET /metrics` on orchestrator (port 8080, no auth required)
- Prometheus scrape target; labels include service=outreach, domain, address, layer, etc.

### Health Check Routing
- Orchestrator: `/health` (daemon registry) + `/metrics` (Prometheus)
- BFF: `/api/health/*` (invariants, watchdog, system, protections, etc.)
- Both backed by PostgreSQL `outreach` database for event/result persistence

---

## Summary

This infrastructure provides:
- **Error capture**: Sentry integration with slog bridge + cron monitoring
- **Metrics**: Prometheus exposition of send pipeline, queue depth, circuit breaker, mailbox health
- **Event logging**: Healing log (auto-recovery actions), watchdog events (alerts), operator audit trail
- **Synthetic monitoring**: Continuous test suite execution + burn-rate calculation
- **Protection probes**: Network/security layer health checks + alert evaluation
- **Cron observability**: Heartbeat table + execution timing + status tracking
- **Operator dashboards**: Observability page, Watchdog page, health banners + alerts

All backends by PostgreSQL; all exposed via JSON APIs for dashboard consumption. Logging follows `op` field discipline for Sentry grouping; error keys consistent across services.

