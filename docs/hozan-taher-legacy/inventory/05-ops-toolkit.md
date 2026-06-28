# Inventory: Ops Toolkit (Endpoints, Scripts, Crons, Playbooks)

> Condensed from automated inventory. Find sources by grep `app.post|app.get` in `features/platform/outreach-dashboard/server.js` and `mux.HandleFunc` in `services/*/web/`.

## 1. BFF API Surface — `features/platform/outreach-dashboard/server.js`

~144 endpoints in 15 categories.

### Health / diagnostics
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | overall BFF + Go orchestrator status |
| `/api/health/auto-recover-trigger` | POST | manual force watchdog + autoRecover (idempotent) |
| `/api/health/invariants` | GET | latest synthetic run + invariants |
| `/api/synthetic-runs` | GET | history of synthetic checks |
| `/api/healing/log` | GET | audit trail of auto-heal actions |
| `/api/healing/stats` | GET | aggregate counts per heal type |

### Proxy operations
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/proxy-pool` | GET | snapshot (`?refresh=1` invalidates cache, `?full=1` includes metadata) |
| `/api/proxy-pool-trend` | GET | 24h sparkline of working count |
| `/api/anti-trace/health` | GET | relay reachability + last-known sources |
| `/api/mailboxes/proxy-exhaust-alert` | GET | sliding-window aggregation of exhaust events |

### Mailbox operations
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/mailboxes` | GET | list with filters |
| `/api/mailboxes/:id` | GET | full row |
| `/api/mailboxes/:id/full-check` | GET (`?force=1`) | SMTP+IMAP+proxy via relay |
| `/api/mailboxes/:id/recover` | POST | force-release stuck mailbox |
| `/api/mailboxes/:id/auth-reset` | POST | zero auth-fail counter |
| `/api/mailboxes/:id/assign-proxy` | POST | single-mailbox proxy reassignment |
| `/api/mailboxes/bulk-assign-proxy` | POST `{ids:[...]}` | bulk reassign |
| `/api/mailboxes/bulk-check` | POST `{ids:[...]}` | async full-check trigger |
| `/api/mailboxes/health-summary` | GET | aggregate status counts |
| `/api/mailboxes/:id/watchdog-events` | GET | self-heal timeline |
| `/api/mailboxes/anonymity-probe` | POST | ring-topology header analysis (S15) |
| `/api/metrics/mailboxes` | GET | Prometheus gauges |

### Campaigns
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/campaigns` | GET | list |
| `/api/campaigns/:id` | GET | full row |
| `/api/campaigns/:id/preflight` | GET | 6-gate readiness check |
| `/api/campaigns/:id/sends` | GET | send history (paginated) |
| `/api/campaigns/:id/start` | POST | unpause campaign (gated by preflight ok=true) |
| `/api/campaigns/:id/pause` | POST | pause campaign |

### Contacts / segments / templates / analytics
- CRUD + filters; list scoring + verification + facts
- Segment composition + preview
- Template render preview (Czech, spin, conditionals)

### GDPR / DSR (Article 15 + 17)
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/dsr/access` | GET (rate-limited 10/min/IP) | aggregate 8 PII tables for subject |
| `/api/dsr/erase` | POST | transactional cascade across 5 tables; keeps suppression_list as Art. 17(3)(b) proof |

## 2. Go Backend Endpoints

### Orchestrator (`features/inbound/orchestrator/web/`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/o` | GET | open-pixel tracking (rate-limited, public) |
| `/c` | GET | click redirect (rate-limited, public) |
| `/health` | GET (`X-API-Key`) | daemons + DB + optional surfaces (stale_advisory_lock_ids, pending_envelopes, greylist_queue_depth) |
| `/dashboard` | GET (`X-API-Key`) | per-daemon last-run times |
| `/recalc` | POST (`X-API-Key`) | force scoring/segment recompute |
| `/api/dsr/access`, `/api/dsr/erase` | — | DSR (Go-side delegating BFF) |

### Relay (`features/outreach/relay/web/`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/submit` | POST | enqueue outbound message |
| `/v1/status/:id` | GET | submission status |
| `/v1/auth-check` | POST | probe single (proxy, smtp_creds) tuple |
| `/v1/probe` | POST | full SMTP+IMAP+proxy probe |
| `/v1/proxy-pool` | GET | snapshot (auth required) |
| `/v1/admin/refresh-pool` | POST | force pool refresh (admin token) |
| `/v1/admin/circuit/:id` | POST | manual circuit-break ops |

## 3. CLI Scripts

### Migrations (`scripts/migrations/`)
- `run.sh` — runner with predecessor ordering + drift detection (sha256 file vs DB record)
- Exit codes: 1=missing env, 3=predecessor missing, 4=drift, 5=apply failed
- `000_schema_migrations.sql` — bookkeeping table
- `001_*…010_*` — operational migrations (campaign cleanup, password encryption, templates, leads, suppression sync, lock audit, body_html column)

### Deploy preflight (`scripts/deploy/preflight.sh`)
- 6 checks: env vars, DB ping, pending migrations, Railway region, branch, tests sentinel
- Exit codes distinct so CI can branch on failure type
- Skip individual checks: `--skip migrations`, etc.

### Other utilities (sample, not exhaustive)
- `scripts/seed-suppressions.sh` — bulk seed honeypots/internal addresses
- `scripts/proxy-pool-snapshot.sh` — fetch + save current pool for debugging
- `scripts/run-stryker.sh` — mutation testing per-module

## 4. Cron Schedule (features/platform/outreach-dashboard/server.js)

All wrapped in `timed(name, fn)` → emits `[cron] <name> duration_ms=<n>` log line + writes to `cron_heartbeats` table.

### Frequent (sub-hour)
| Cron | Cadence | Stagger | Purpose |
|---|---|---|---|
| Synthetic smoke | 60s | 95s | 10 health invariants |
| Stale guard | 60s | — | mark stale advisory locks |
| Proxy cache warm | 5 min | 90s | prefetch pool snapshot |
| Proxy watchdog | 5 min | — | trigger relay refresh on low pool |
| Config drift | 5 min | — | detect drift between DB + env |
| Greylist retry | 10 min | 100s | replay queued sends |
| Enrichment MV | 10 min | — | refresh materialized view |
| IMAP poll | 15 min | 30s | fetch inbox replies |
| Bounce flip | 15 min | 75s | bounce → email_status |
| Mailbox healing | 15 min | 90s | trigger heal cycle |
| Mailbox health cycle | 30 min | 135s | full eval auto-heal conditions |
| Bounce cascade throttle | 30 min | 85s | escalate sustained bounces |
| Campaign watchdog | 60 min | 120s | re-check paused campaigns |
| Scoring recompute | 60 min | — | per-contact rescore |

### Daily (Prague TZ, DST-correct via Intl.DateTimeFormat)
| Cron | Time | Purpose |
|---|---|---|
| Midnight reset | 00:00 | clear daily counters, resolve 24h pauses |
| DNS blacklist | 02:00 | check sender domain reputation |
| Email reverify | 03:00 | re-validate stale `valid` contacts |
| Audit retention | 04:00 | prune old audit rows |
| Warmup advance | 05:00 | bump warmup_day if recovery detected |
| Daily report | 07:00 | sends/bounces/replies summary |

### Periodic
- Adaptive refresh (every 6h)
- DST schedule recompute on each daily-cron tick

## 5. Operational Playbooks (`docs/playbooks/`)

### First send / launch
- `first-campaign-launch.md` — generic 0→1→5→20 staircase + rollback triggers
- `FIRST-CAMPAIGN-SPRINTS.md` — TDD sprint plan for first-campaign readiness
- `SEND-OPERATIONS.md` — send window, warmup, daily cap, 10-step troubleshooting

### Self-healing
- `MAILBOXES-SELF-HEALING-SPRINTS.md` — sprint design S1-S4 (proxy refresh, watchdog daemon, dashboard timeline, bounce_hold acceleration)
- `BFF-SELF-HEALING-SPRINTS.md` — BFF cron/healing patterns
- `heal-action-runbook.md` — operator manual for heal actions

### Migrations + secrets
- `migration-rollout-plan.md` — operator runbook for applying 005 + 007 (suppression sync + lock audit)
- `secret-rotation.md` — per-secret rotation procedure + blast radius
- `secret-hygiene.md` — env var lifecycle
- `S5-mailbox-encryption.md` — pgcrypto KEK rotation procedure (4-phase)

### Compliance / DSR
- `dsr-runbook.md` — GDPR DSR operator workflow + SQL templates
- `relay-setup.md` — anti-trace relay deployment + ToS

### Observability
- `cron-schedule.md` — canonical list of all crons + alert thresholds
- `SENTRY-ALERTS.md` — alert rules + on-call playbook
- `slog-conventions.md` — `op` field convention + entity-key naming
- `runbook-async-job-pattern.md` — async job idempotency + retry
- `runbook-jobs-write-errors.md` — bounce_hold / lock_acquire failure recovery
- `auth-fail-response.md` — operator response to AUTH_FAIL alert
- `EGRESS-FIREWALL-OPS.md` — firewall config for SMTP egress lockdown

## 6. Service CLAUDE.md Files

| Service | Path | Purpose |
|---|---|---|
| campaigns | `features/outreach/campaigns/CLAUDE.md` | runner, sender, content, advisory locks, slog op-field |
| common | `features/platform/common/CLAUDE.md` | shared lib (alert, audit, calendar, config, db, envconfig, health, humanize, metrics, telemetry, token) |
| contacts | `features/acquisition/contacts/CLAUDE.md` | enrichment, validation, ARES + firmy.cz |
| inbox | `features/inbound/inbox/CLAUDE.md` | reply-inbox manual handler |
| mailboxes | `features/outreach/mailboxes/CLAUDE.md` | mailbox state machine, watchdog, encryption |
| mcp | `features/platform/mcp/CLAUDE.md` | MCP integration |
| orchestrator | `features/inbound/orchestrator/CLAUDE.md` | HTTP surface, IMAP poller, intelligence loop |
| privacy-gateway | `features/compliance/privacy-gateway/CLAUDE.md` | DSR + privacy operations |
| relay | `features/outreach/relay/CLAUDE.md` | anti-trace relay, transport, proxy pool |
| scrapers | `features/acquisition/scrapers/CLAUDE.md` | data extraction sources |
| worker | `features/platform/worker/CLAUDE.md` | background job processor |

Plus apps:
- `features/platform/outreach-dashboard/CLAUDE.md` — React 19 + Vite + Express BFF + degraded UI store
- `modules/outreach/CLAUDE.md` — historical home + business context (red lines, jurisdiction, where code lives now)

## 7. Key Operational Patterns

### Cron heartbeats
- Every cron writes to `cron_heartbeats` (last_run_at, duration_ms, status, error)
- `/api/healing/stats` aggregates per-cron success rate
- Sentry alert if heartbeat missing >2× expected interval

### DST-correct scheduling
- Daily crons use `Intl.DateTimeFormat({timeZone: 'Europe/Prague'})` to compute next-fire-at
- Reschedule after each tick (avoids March/October drift)
- Tests in `tests/unit/lib/cron-schedule.test.js`

### Idempotency + retry
- Greylist queue exponential backoff (1m → 2m → 5m → 15m → drop)
- Bounce escalation with 24h cooldown (anti-thrash)
- DSR endpoints idempotent + audit-logged

### Healing audit trail
- `watchdog_events` table — every auto-heal + manual op
- `mailbox_alerts` table — score drops, auth failures, bounce escalations
- `cron_heartbeats` — every cron tick (success or error)
- All readable via `GET /api/healing/log`

### SMTP-egress lockdown (R4–R5)
- BFF cannot dial SMTP/IMAP directly
- All probes go through relay `/v1/auth-check` and `/v1/probe`
- Hard rule per memory `feedback_no_direct_smtp`

## 8. Common Operations Recipes

### Check why a campaign won't send
```bash
curl http://localhost:3100/api/campaigns/<ID>/preflight | jq
```

### Reassign all active mailboxes to fresh proxies
```bash
# 1. Force pool refresh
curl -X POST $RELAY_URL/v1/admin/refresh-pool -H "Authorization: Bearer $RELAY_ADMIN_TOKEN"
# 2. Bulk reassign
curl -X POST http://localhost:3100/api/mailboxes/bulk-assign-proxy \
  -H "Content-Type: application/json" -d '{"ids":[1,3,631]}' | jq
```

### Force watchdog + auto-recover cycle
```bash
curl -X POST http://localhost:3100/api/health/auto-recover-trigger | jq
```

### Recover a stuck mailbox manually
```bash
curl -X POST http://localhost:3100/api/mailboxes/1/recover \
  -H "Content-Type: application/json" -d '{"reason":"manual"}'
```

### Export DSR for a contact (GDPR Art. 15)
```bash
curl "http://localhost:3100/api/dsr/access?email=foo@example.com" -H "X-API-Key: $KEY"
```

### Check relay pool health from outside
```bash
curl $RELAY_URL/api/health/proxy-sources | jq
```

### Apply a new migration
```bash
DATABASE_URL=... ./scripts/migrations/run.sh
# Exit 3 = predecessor missing; exit 4 = drift; exit 5 = apply failed
```
