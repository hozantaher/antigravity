# Heal Action Runbook

> Operator manual for the self-healing surfaces added in initiative
> `docs/initiatives/2026-04-26-comprehensive-testing-self-healing.md`.
> Use when investigating heal events, escalations, or SLO breaches.

## Heal action surfaces

Each heal action emits 5 observability surfaces (HX10 audit enforces):

1. **slog** — Go: `slog.Warn` with `op` field. JS: `console.warn` + Sentry breadcrumb.
2. **Prometheus metric** — `outreach_heal_total{action,outcome,entity_type}`
3. **Sentry breadcrumb** — `playbook` tag pointing to this runbook section
4. **healing_log row** — DB audit trail with `entity_type`, `entity_id`, `action`, `reason`, `resolved_at`
5. **reporter `bottlenecks` kind** — surfaced in `pnpm report` JSON

If any surface is missing, the discipline test `src/test/observability-audit.test.js` fails.

---

## Heal libraries (features/platform/outreach-dashboard/src/lib/)

| Lib | Purpose | Key API |
|---|---|---|
| `heal-backoff.js` | Exponential cooldown schedule | `computeNextCooldown(history, now)` → 30m/1h/4h/12h/24h ladder |
| `heal-budget.js` | Token-bucket rate limiter | `HealBudget.allow(entity, n)` → 30/h per entity, 1000/h system |
| `heal-cascade.js` | DAG dependency recovery | `cascadeFailure`, `cascadeRecovery`, `isHealReadyFor` |
| `heal-coordinator.js` | Concurrent arbitration | `runUnderLock(entity, holder, fn)` — only one holder wins |
| `heal-counterfactual.js` | Net-positive validation | `evaluateCounterfactual({primaryFn, shadowFn, metric, epsilon})` |
| `heal-deduper.js` | Storm idempotency | 1000 req → 1 applied + 999 deduped via composite key |
| `heal-escalation.js` | Terminal escalation latch | `detectEscalation(history, now)` → `needs_human` after 3×/30min OR 5×/24h |
| `heal-explanations.js` | Czech NL summaries | `renderHealExplanation({action, entity_type, entity_id, reason, …})` |
| `heal-permissions.js` | Scope-bounded actions | `canPerform(strategy, op, scope)` — default-deny |
| `heal-pid.js` | Self-tuning cooldown | PID controller adjusts cooldown based on commit/rollback rate |
| `heal-predictive.js` | Anomaly pre-emption | `AnomalyDetector` — Mahalanobis-like score, 'degrading' trigger |
| `heal-rollback.js` | Two-phase commit/rollback | `HealTransaction.begin/verify/commit/rollback` |
| `heal-rootcause.js` | Multi-hop attribution | `attributeRootCause(dag, states, symptom)` → upstream-biased root |
| `suppression-union.js` | Cross-table UNION | `unionSuppressions(outreachSuppressions, suppressionList)` |

---

## Triage flow when heal-event detected

### 1. Check severity

`pnpm report` shows current bottlenecks + slo_breaches. If a `slo_breach` row
includes a `runbook_url`, click straight to that section.

### 2. Identify root cause

If multiple entities are unhealthy, run `heal-rootcause` to find the deepest
upstream cause. Example:

```
mb=3 darkens (last_score_at >24h)
  ← runFullCheckCron stalled
  ← BFF restart loop
  ← anti-trace 503 cascade
  ← Railway env var removed
```

Heal target: **anti-trace** (root), not mb=3 (symptom).

### 3. Check counterfactual before applying

If heal-strategy track record is poor (`HealStrategyScorer.shouldDemote`
returns true), prefer manual investigation over auto-heal.

### 4. Heal under lock

Never apply destructive heal without `heal-coordinator.runUnderLock` — prevents
double-application across replicas.

### 5. Verify after-the-fact

Use `heal-rollback.HealTransaction`:
- `begin(state, action)` snapshots state
- `verify(handle, currentState)` after observation window (5 min default)
- If metric improved → `commit`. If degraded → `rollback`.

### 6. Check for storm

`heal-deduper` ensures 1000 requests for same (entity, kind) → 1 applied + 999
ignored. If you see `heal_throttled` events, check the storm size annotation
in healing_log to identify what triggered the storm.

---

## Common scenarios

### Mailbox auto-pause loop

**Symptom**: `healing_log` shows alternating auto_pause/auto_resume for same mb every <30min.

**Diagnosis**: heal-backoff schedule (30m → 1h → 4h → 12h → 24h) fires escalation after 5 cycles in 24h via `heal-escalation`. Mailbox status becomes `needs_human`.

**Action**:
1. Check `outreach_mailboxes.status='needs_human'` in DB
2. Investigate root cause (auth failure? bounce cascade? SMTP creds rotated?)
3. After fix, manually clear escalation:
   ```sql
   UPDATE outreach_mailboxes SET status='active' WHERE id=<X>;
   ```
4. Auto-heal disabled until DB row reset.

### Engine panic + restart cycle

**Symptom**: Sentry events with `playbook=sender_panic`, engine_health UPSERT cycle.

**Diagnosis**: `superviseSender` (features/inbound/orchestrator/cmd/outreach/sender_daemon.go) caught panic → DaemonError marshalled → engine restarts.

**Action**:
1. Check Sentry stack for panic origin
2. Common causes: anti-trace down, DB connection lost, mailbox creds changed mid-flight
3. If 10 panics in 5min → `alertClient.DaemonPanic` fires (operator paged)

### Proxy pool empty streak

**Symptom**: `consecutive_zero_refreshes >= 3`, `empty_pool_critical=true`.

**Diagnosis**: Proxy provider down OR all candidates unhealthy.

**Action**:
1. Check `features/outreach/relay/internal/transport/proxy_pool.go` logs
2. Source rotation: proxifly → geonode/proxyscrape fallback
3. Counter resets on first non-zero refresh

### Cron stall

**Symptom**: `cronHeartbeats()` reports `>2× interval` since last success.

**Diagnosis**: Cron callback threw OR hung. `withCronGuard` should have caught it.

**Action**:
1. Check console logs for `[cron] X exception=...`
2. Check `protection_probes` / `mailbox_check_history` last write times
3. If stuck, restart BFF (cron re-schedules on boot)

---

## SLO bounds

| Metric | P50 | P99 |
|---|---|---|
| Mailbox auto-pause → auto-resume | <2 min | <15 min |
| Cron stall recovery | <30 s | <2 min |
| Proxy pool refresh | — | <90 s |
| Anti-trace failover | <30 s | <2 min |

Reporter `slo_breaches` rows enforce these. If any exceeded > 1× per month,
investigate (alert burn-rate budget).

---

## Heal action permissions

`heal-permissions.js` enforces scope:

| Strategy | Allowed | Blocked |
|---|---|---|
| `mailbox_heal` | pause, resume, reset_breaker | drop_campaign, modify_creds, rotate_secrets |
| `cron_heal` | restart_cron, log_stall | mutate_db_schema, drop_table |
| `engine_heal` | restart_engine, reset_supervisor | modify_mailbox_creds, alter_campaign |
| `proxy_heal` | rotate_proxy, refresh_pool | mutate_anti_trace_config |

Default-deny on unknown strategies/operations. Audit log is JSON-safe (no
prototype pollution, no functions, no circular refs).

---

## Reference

- Initiative: `docs/initiatives/2026-04-26-comprehensive-testing-self-healing.md`
- Discipline tests:
  - `src/test/observability-audit.test.js` (5-surface ratchet)
  - `src/test/heal-explanation-audit.test.js` (Czech NL completeness)
- Two suppression tables: see memory `project_two_suppression_tables.md` — `outreach_suppressions` (Go) + `suppression_list` (BFF). Union at every read via `suppression-union.js`.
