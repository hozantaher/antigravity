# OPERATIONAL + PROTECTION + GDPR Test Gap Analysis
**Date**: 2026-04-27 | **Scope**: OPS features, health surfaces, watchdog daemon, DSR, migrations, metrics, audit

---

## Feature Catalog + Test Coverage Matrix

### 1. Watchdog Daemon (OPS)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **Tick loop + metrics** | `features/outreach/mailboxes/watchdog/daemon.go:165-183` | ✓ `daemon_test.go` table-driven; `TickResult` assertions | None | Prometheus `watchdog_tick_duration_ms` histogram + `watchdog_checked_total` |
| **Auth-fail spike detection** | daemon.go:289-296 | ✓ `authfails_events_test.go` mocks `AuthFailReader.CountRecent` | None | slog structured `watchdog tick` log: `auth_spikes=N` |
| **Proxy swap (on spike)** | daemon.go:307-311 | ✓ `daemon_decay_swap_test.go` full lifecycle; mocks `ProxyFetcher` + `Store` | None | watchdog_events table: `EventProxySwap` with `from_proxy`, `to_proxy`, `country` metadata |
| **Bounce decay** | daemon.go:277-283 | ✓ `daemon_decay_swap_test.go` tests `recentlyBounced` heuristic + `ResetBounce` call | None | watchdog_events: `EventBounceDecay` with old→new count |
| **Circuit breaker trip/close** | daemon.go:252-261 | ✓ `circuit_breaker_test.go` 45+ cases; race-safe atomic state | Missing edge case: concurrent Tick + manual ReleaseHold | Health endpoint `/api/health/auth-fail-alerts` returns `count` of recent `EventAuthFailAlert` |
| **Auth-fail alert (SEND-S6.3)** | daemon.go:383-437 | ✓ `auth_fail_alert_test.go` + `auth_fail_alert_property_test.go` (fast-check cooldown); webhook stub | Missing: webhook timeout behavior under load; double-alert race with manual Tick | Webhook POST to AlertWebhookURL; slog `mailbox_auth_fail_alert` with `fail_count`, `window_min` |
| **Alert webhook delivery** | daemon.go:443-495 | ✓ `daemon_alert_webhook_test.go` tests timeout + error codes (4xx/5xx silent) | Missing: circuit breaker on failing webhooks (will keep POSTing forever) | HTTP POST to SLACK_WEBHOOK_URL, timing in trace spans |

### 2. Health Endpoints (OPS + STATUS)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **/healthz public liveness** | `features/inbound/orchestrator/web/server.go:217-225` | ✓ `server_test.go` OK/degraded status | None | `GET /healthz` → `{"status": "ok\|degraded"}` + slog health check warnings |
| **/health daemon statuses** | server.go:260-308 | ✓ `health_surfaces_test.go` mocks all optional surfaces | None | Daemon status from registry; `uptime_seconds`, `db` ping result |
| **Optional surfaces (BF-F4)** | server.go:230-258 | ✓ `health_surfaces_test.go`: StaleAdvisoryLocks, PendingEnvelopes, GreylistQueueDepth with panic recovery | Missing: performance impact of safeProbe functions under 1000+ lock IDs | Each surface independently recoverable; omitted if unwired or panicked |
| **Stale advisory lock detection** | `health_surfaces_test.go:L50+` | ✓ Mocked per BF-F4 contract | Missing: real lock age calculation under clock skew | `/health` → `stale_advisory_lock_ids: [int64]` when > 10m old (flips status to degraded) |
| **Pending envelope backlog** | server.go:236 | ✓ Mocked return-value assertions | Missing: anti-trace-relay queue measurement under sustained send load | `/health` → `pending_envelopes: int` (optional field) |
| **Greylist queue depth** | server.go:237 | ✓ Contract test mocks row count | Missing: per-domain breakdown; expired row detection | `/health` → `greylist_queue_depth: int` when email_verify_queue rows due |

### 3. Tracking Pixels + Click Redirects (PROTECTION)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **Open pixel /o (BF-D4)** | server.go:161-181 | ✓ `server_test.go` + `property_monkey_test.go` never panics; EXISTS guard contract | None | `recordTrackingEvent` logs unknown token (slog Warn); GIF served regardless |
| **EXISTS guard (BF-D4)** | server.go:343-357 | ✓ `server_test.go` INSERT...WHERE EXISTS; 0 rows logged as Warn | None | slog `web: tracking event for unknown send_event_id` with `send_event_id`, `event_type` |
| **Click redirect /c (safe URL)** | server.go:185-206 | ✓ `coverage_gaps_test.go` validates `isSafeRedirectURL`; blocks data:, javascript: | None | HTTP 302 on safe URL; 400 on unsafe; tracking logged only for valid tokens |
| **IP + User-Agent capture** | server.go:334-357 | ✓ Inserted into tracking_events; assert in test mocks | None | tracking_events table: `ip_address`, `user_agent`, `created_at` |
| **Contact status opened→clicked** | server.go:364-375 | ✓ `coverage_gaps_test.go` UPDATE contacts status on 'open' event | Missing: re-idempotency under duplicate opens from same send_event_id | `contacts.status = 'opened'` update logged separately (M-W1 slog.Warn on error) |
| **Rate limiting** | server.go:59-61 | ✓ `ratelimit_test.go` per-IP token bucket; 100/min open, 50/min click | Missing: behavior across NAT/proxy (shared IP); distributed cache in multi-instance | 429 when IP exceeds bucket; reset per minute window |

### 4. GDPR: Data Subject Requests (Article 15 + 17)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **Article 15 access aggregation** | `features/platform/outreach-dashboard/tests/contract/bff-dsr.contract.test.ts:81-145` | ✓ Contract test: 8-table parallel query, found_total count, response shape | Missing: performance test with 1M+ row contact/send_events; timeout handling | GET `/api/dsr/access?email=<addr>` returns JSON: contacts[], outreach_contacts[], send_events[], reply_inbox[], tracking_events[], suppression_list[], outreach_suppressions[], audit_log[] |
| **8-table read consistency** | dsr.contract.test.ts:94-130 | ✓ Mocked Promise.all query execution order; table presence check | Missing: eventual consistency across Schema A + B replication; repeatable read isolation test | All queries fire in parallel; missing any table causes 500; each table result in response |
| **Article 17 erasure cascade** | dsr.contract.test.ts:161+ (see src/dsr.ts) | ✓ Contract test queues results in transactional order: contacts → send_events → tracking_events → suppression → audit | Missing: foreign key cascade verification; orphaned records detection; performance on 100K+ send_events | DELETE from 5 tables within txn; audit log records DSR erase event; all-or-nothing semantics |
| **DSR audit logging** | dsr.contract.test.ts:147-155 | ✓ Contract verifies operator_audit_log INSERT on access/erase | Missing: log content validation (email, action, timestamp, operator_id); tamper detection | operator_audit_log: `action='dsr_access'|'dsr_erase'`, `email`, `recorded_at`, `metadata` |
| **Email validation + GDPR gate** | dsr.contract.test.ts:84-92 | ✓ 400 on missing/invalid email | Missing: multi-ID DSR request (email + phone); batch erase SLO | Validates email format via regex; rejects `notanemail` (no @) |

### 5. Honeypot Detection (PROTECTION)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **Typo domain detection** | `features/acquisition/contacts/enrichment/honeypot.go:56-75` | ✓ `honeypot_insert_sqlmock_test.go` Czech domain map (seznam→seznam.cz, gmail→gmial.com typos) | None | HoneypotSignal: type='typo_domain', severity='medium', Fix field suggests correction |
| **Role-based prefix filter** | honeypot.go:77-83 | ✓ Detects abuse, postmaster, noreply, support, etc. | Missing: regex-based patterns vs hardcoded list; new prefix addition workflow | severity='low'; Details field populated |
| **Suspicious pattern detection** | honeypot.go:86-97 | ✓ test, asdf, qwerty, demo, temp patterns | Missing: entropy-based detection for random strings; unicode/emoji patterns | severity='high'; Details: 'suspicious local part' |
| **All-numeric local part** | honeypot.go:99-100 (partial read) | ? Incomplete in source | Missing: confirmation of numeric-only rejection; high severity | Should reject 12345@domain |

### 6. Email Verification (PROTECTION)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **DNS/MX validation** | `features/acquisition/contacts/validation/` (shared enrichment flow) | ✓ Validation test mocks resolver | None | Reject domain if no MX record |
| **RCPT TO probe** | `features/acquisition/contacts/company/email_verify.go` | ✓ Domain lock 5s spacing, rate-limiter | Missing: SMTP timeout handling; connection pooling exhaustion test | SMTP probe to MX: reject if RCPT TO returns 550 |
| **Greylist backoff** | `features/outreach/campaigns/sender/backoff.go` | ✓ Tests SMTPClass → backoff duration (temporary vs permanent) | None | SMTPClass 4xx → exponential backoff (5m, 1h, 6h); 5xx → permanent hold |

### 7. Migration Runner + Drift Detection (OPS)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **BF-G2 ordering enforcement** | `scripts/migrations/run.sh:33-88` (bash) | ✓ `scripts/migrations/run_test.sh` table-driven; predecessor check, out-of-order detection | Missing: concurrent migration runner safety (no file lock); idempotence proof | Exit code: 0=ok, 1=fail, 2=out-of-order, 3=predecessor missing, 4=drift detected |
| **BF-G3 sha256 drift detection** | run.sh:148-160 (partial; file in 100-line limit) | ✓ Content hash stored in schema_migrations; test verifies mismatch detection | Missing: hash algorithm upgrade path; rollback safety | Detects file content changes post-deploy; blocks re-run if mismatch |
| **Idempotent schema_migrations table** | run.sh:56 | ✓ `CREATE TABLE IF NOT EXISTS` in bookkeeping migration | None | 000_schema_migrations.sql applies once; subsequent runs skip |

### 8. Deploy Preflight (OPS)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **BF-G4 env validation** | `scripts/deploy/preflight.sh:66-76` | ✓ Checks DATABASE_URL, OUTREACH_API_KEY, ANTI_TRACE_RELAY_TOKEN present | Missing: secret format validation (key length, charset); bleeding detection | Exit code: 2 if var missing; CI gate on exit 0 |
| **DB connectivity check** | preflight.sh:79-93 | ✓ psql SELECT 1 | Missing: connection pool size test; replication lag check | EXIT 3 if psql fails |
| **Pending migrations gate** | preflight.sh:96-110 (partial) | ✓ Calls `run.sh --dry-run`; blocks push if pending | Missing: post-deploy schema verification; version lock file | EXIT 4 if migrations pending |
| **Region lock (EU only)** | preflight.sh:111-115+ (partial) | ✓ Checks RAILWAY_REGION=eu or manual SCC approval | Missing: automation for multi-region deploy validation | EXIT 5 on non-EU unless approved |
| **Test sentinel check** | preflight.sh (referenced) | Missing | Missing: which tests? green sentinel file? | Verify `pnpm test` passed before deploy |
| **Branch check** | preflight.sh (referenced) | Missing | Missing: remote branch validation logic | EXIT on branch mismatch vs REMOTE_BRANCH env |

### 9. Sentry + Telemetry (OPS)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **BF-F3 BuildReleaseTag** | `features/platform/common/telemetry/sentry.go` + `sentry_test.go` | ✓ `sentry_test.go` composes GIT_SHA→@<sha> | None | Release tag on every Sentry event for version cohort grouping |
| **slog→Sentry bridge** | `features/platform/common/telemetry/handler.go` | ✓ Structured logs with `op` field routed to Sentry; errors auto-grouped | None | Every slog.Error flows to Sentry with source location |
| **MonitoredJob wrapper** | telemetry/monitor.go | ✓ Wraps goroutines with panic recovery + Sentry report | Missing: timeout enforcement; hanging job detection | Panic in job posts to Sentry; returns error channel |
| **Daemon status registry** | `features/platform/common/health/health.go` | ✓ `health_test.go` tracks LastSeen, health verdict per daemon | None | `/health` daemon status snapshot; slog warning if LastSeen > 2× interval |

### 10. Prometheus Metrics (OPS)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **Sender counters** | `features/platform/common/metrics/metrics.go` | ✓ `metrics_test.go` + `metrics_property_test.go` (fast-check label cardinality); race-safe atomic increments | Missing: cardinality explosion detection (too many unique label values) | Counter: `send_attempts_total{mailbox, status}`, `tracking_event_total{type}` |
| **Mailbox state gauges** | metrics.go | ✓ Property test: concurrent updates to mailbox status gauge | Missing: stale gauge detection (metric not updated > 1h) | Gauge: `mailbox_status{address, status}` |
| **Intelligence loop timing** | metrics.go | ✓ Histogram assertions in property test | Missing: P99 latency alarm configuration | Histogram: `intelligence_loop_duration_seconds` bucketed |
| **Protection probe outcomes** | metrics.go | ✓ Test counters: honeypot_rejected, mail_invalid, typo_corrected | Missing: false-positive rate tracking | Counter: `protection_probe{outcome}` |

### 11. Synthetic Monitoring + Invariants (OPS + AUDIT)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **Audit contract verification** | `features/platform/outreach-dashboard/tests/audit/observability-audit.test.js` | ✓ Checks all slog Errors have `op` field for Sentry grouping | Missing: Warn/Info log `op` presence; observability budget | Test fails build if any uncategorized error |
| **SLO tracking** | `features/platform/outreach-dashboard/tests/audit/heal-slo.test.js` | ✓ Asserts daemon recovery < 5min SLO | Missing: per-daemon SLO; multi-instance coordination | Synthetic test queries watchdog_events; calculates MTTR |
| **Workflow Sentry audit** | `features/platform/outreach-dashboard/tests/audit/workflow-sentry.test.ts` | ✓ Verifies Sentry events on failure path | Missing: release tag mismatch detection; invalid release format | Runs end-to-end flow; confirms error in Sentry |
| **Healing explanation audit** | `features/platform/outreach-dashboard/tests/audit/heal-explanation-audit.test.js` | ✓ Checks AutoHealed boolean on watchdog_events reflects actual healing | Missing: orphaned auto-healed events (no follow-up) | Scan watchdog_events.AutoHealed=true; assert follow-up action logged |
| **Prod smoke test (synthetic)** | `features/platform/outreach-dashboard/tests/synthetic/prod-smoke.test.js` | ✓ Runs in PROD on schedule (Phase 3 planned) | Missing: alerting SLO; on-call escalation | Pings `/healthz`, tracks pixel tracking, samples DSR access latency |

### 12. Cron Heartbeats (OPS)
| Feature | Source | Test Coverage | Gap | Real-Time Verification |
|---------|--------|---|---|---|
| **timed(name, fn) wrapper** | Shared across campaign/mailbox/intelligence loops | ✓ Asserts heartbeat recorded in health registry on success + error paths | Missing: timeout enforcement; hang detection | slog `timed_task` with `duration_ms`, `error` if present |
| **Registry daemon snapshot** | `features/platform/common/health/health.go` | ✓ `health_test.go` LastSeen update cadence | Missing: alert on LastSeen gap > 2× expected interval | `/health` daemons field shows status per task |

---

## Test Gap Summary (Priority Order)

### Critical Gaps (Production Risk)
1. **Webhook delivery circuit breaker (watchdog alert)** — Daemon will retry forever on 5xx; no backoff or disabling.
   - Proposal: Track consecutive webhook failures per mailbox; disable alerts after 5 failures for 24h window.
   - Real-time test: Monitor AlertWebhookURL response codes in Prometheus counter.

2. **Distributed migration safety** — `run.sh` has no file lock; concurrent runners corrupt schema_migrations.
   - Proposal: Use PostgreSQL advisory lock; EXIT 1 if lock held > 60s.
   - Real-time test: Multi-pod test with `--apply` flag simultaneous invocation.

3. **DSR erasure performance + consistency** — No timeout; 100K+ send_events deletion can hang; no repeatable read confirmation.
   - Proposal: 30s query timeout per DELETE; use SERIALIZABLE isolation; test with large dataset.
   - Real-time test: Sample DSR erase latency P99 per email; alert if > 10s.

4. **Health surface panic recovery scope** — `safeStaleProbe`/`safeIntProbe` recover from panic but don't log root cause.
   - Proposal: Log panic detail in Sentry before returning nil/−1.
   - Real-time test: Inject panic in a health surface; verify slog Warn + Sentry event.

### Medium Gaps (Observability + Compliance)
5. **Webhook timeout under load** — No load test; may accumulate hanging POST goroutines.
   - Proposal: Add MaxConnsPerHost limit to AlertWebhookClient; test with slow endpoint.
   - Real-time test: Saturate AlertWebhookURL receiver; measure goroutine count.

6. **Honeypot: all-numeric detection incomplete** — Source cut off; unclear if applied.
   - Proposal: Confirm numeric-only rejection in code + add test case.
   - Real-time test: Verify 12345@domain rejected by enrichment pipeline.

7. **GDPR audit log tampering** — No signature or immutability check on operator_audit_log.
   - Proposal: Add Blake3 hash of row content; verify on DSR erasure replication.
   - Real-time test: Synthetic test inserts audit row; scans for hash integrity.

8. **Cardinality explosion in Prometheus metrics** — No limit on unique label values.
   - Proposal: Add cardinality limit (e.g., 10K unique mailbox addresses); emit warning metric.
   - Real-time test: Stress test with 100K unique mailbox labels; measure scrape latency.

### Low Gaps (Enhancement)
9. **Test sentinel validation** — Preflight script mentions test sentinel but logic not shown.
   - Proposal: Verify `pnpm test` green sentinel file before deploy; document in README.
   - Real-time test: E2E preflight check with failing tests should block.

10. **Branch validation** — Preflight script references REMOTE_BRANCH but implementation incomplete.
    - Proposal: Implement git rev-parse local vs origin/REMOTE_BRANCH comparison.
    - Real-time test: Attempt deploy on wrong branch; verify EXIT 1.

---

## Real-Time Verification Proposals (Live Monitoring)

### Prometheus + Grafana Dashboard
- **watchdog tick duration**: Histogram p95/p99; alert if > 30s
- **auth_fail_alert webhook status codes**: Counter by status (200, 4xx, 5xx, timeout)
- **migration runner drift detections**: Counter; alert on any drift
- **DSR erase latency**: Histogram per email domain; alert p99 > 10s
- **health surface panic rate**: Counter; integrate with Sentry

### Structured Logs (slog → Sentry)
- Search `op="watchdog.Tick"` + `error != nil` for daemon failures
- Search `web.recordTrackingEvent/unknown` to detect token validation issues
- Search `dsr_erase` audit log for completion status
- Search `migration_runner` for drift/ordering violations

### Synthetic Tests (Hourly, Running in PROD)
- POST to `/o?t=<stale_id>` (expired send_event); verify slog Warn + GIF served
- GET `/api/dsr/access?email=<existing>` → measure latency (SLO < 2s); verify all 8 tables queried
- GET `/health` → verify all optional surfaces present or omitted consistently
- POST `/api/recalc` → verify contact score recalc completes in < 5min

---

## Recommendations

1. **Add webhook circuit breaker** (Critical) — Prevent thundering herd on failing webhooks.
2. **Lock migration runner** (Critical) — PostgreSQL advisory lock with timeout.
3. **DSR timeout + isolation** (Critical) — 30s timeout; SERIALIZABLE; large dataset test.
4. **Log panic details** (High) — Health surfaces should emit structured error before recovery.
5. **Cardinality controls** (High) — Prometheus label cardinality limits + alerting.
6. **Complete honeypot numeric detection** (Medium) — Confirm implementation; add test.
7. **GDPR audit immutability** (Medium) — Blake3 signature on operator_audit_log.
8. **Finish preflight validation** (Low) — Test sentinel, branch, region checks fully implemented.

---

**Next Step**: Integrate real-time monitoring into ops dashboard; schedule weekly review of gap remediation status.
