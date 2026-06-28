# Subsystem Map — Protections (Health Probes + Alerts + Ochrany Panel)

**Version:** 2026-05-02
**Owner:** features/inbound/orchestrator/protections
**Last verified:** 2026-05-02 via git log + surface scan
**Refresh:** 2026-05-02 @ 12cbedd9 (deadcode cleanup: test helpers in probe/o1_property_monkey_test.go removed)

The protections subsystem continuously monitors the health of critical pipeline layers at two observable depths (L2=alive, L3=correct), persists results to `protection_probes`, and manages alert lifecycle in `protection_alerts`. Results surface in the BFF's Ochrany panel (12×2 cells).

> **Mandatory read:** before adding a new protection probe, changing alert thresholds, or consuming `protection_probes`/`protection_alerts` from the BFF.
>
> **Recent changes (G5.1):** Deadcode audit (#633) removed orphan test helper `buildWarmupPlan` in `probes_l3_state.go`. No probe logic changed; surface below reflects current state.

## Components

| Component | File | Role |
|-----------|------|------|
| `Scheduler` | `features/inbound/orchestrator/protections/probe/probe.go:69` | Runs N probers on independent tickers; one goroutine per prober |
| `Prober` interface | `probe/probe.go:53` | `Layer() string`, `Level() Level`, `Interval() Duration`, `Run(ctx) Result` |
| `Sink` interface | `probe/probe.go:63` | `Write(ctx, Result) error` — persists probe results |
| `Recorder` | `probe/recorder.go` (not read) | Concrete Sink: writes to `protection_probes` table |
| `AntiTraceL2` | `probe/probes_l2.go:17` | L2: GET `{baseURL}/healthz` → 200 OK; cadence 30s |
| `ProxyPoolL2` | `probe/probes_l2.go:75` | L2: GET BFF `/api/proxy-pool?full=1` → working > 0; cadence 30s |
| `WatchdogL2` | `probe/probes_l2.go:144` | L2: `watchdog_events` MAX(created_at) < 15min; cadence 60s |
| `DBPoolL2` | `probe/probes_l2.go:203` | L2: `SELECT 1`; cadence 30s |
| `SenderEngineL2` | `probe/probes_l2.go:250` | L2: `outreach_config` key `sender_heartbeat_at` < 30min; cadence 60s |
| `AntiTraceL3` | `probe/probes_l3.go:26` | L3: GET `{baseURL}/v1/health` → bridge reachable; cadence 5min |
| `ProxyPoolL3` | `probe/probes_l3.go:103` | L3: SOCKS5-tunnel echo → egress IP changed; cadence 10min |
| `HeaderGateL3` | `probe/probes_l3.go:275` | L3: CR/LF header injection canary via `HeaderBuilder`; cadence 15min |
| `CircuitBreakerL3` | `probe/probes_l3_state.go:65` | L3: shadow-tx circuit_opened_at + trip_count UPDATE; cadence 5min |
| `CanaryL3` | `probe/probes_l3_state.go:128` | L3: shadow-tx canary_remaining decrement + last_canary_send; cadence 5min |
| `BounceGuardL3` | `probe/probes_l3_state.go:197` | L3: shadow-tx consecutive_bounces threshold → status=bounce_hold; cadence 10min |
| `WarmupRespectL3` | `probe/probes_l3_state.go:271` | L3: warmup plan monotonically non-decreasing; pure (no DB); cadence 15min |
| `SendRateL3` | `probe/probes_l3_state.go:367` | L3: stub SKIP — in-memory rate limiter covered by SenderEngineL2 |
| `Evaluator` | `alert/evaluator.go:40` | Reads `protection_probes` history; opens/escalates/resolves `protection_alerts` |

## Scheduler tick flow

```
Scheduler.Run(ctx)
  → one goroutine per Prober
      each goroutine: Prober.Run immediately, then on Interval() ticker
      → result.Latency set if not returned by prober
      → Sink.Write(result) in detached 5s context   // so outer cancel doesn't abort last persist
      → onError callback if Sink.Write fails
```

Source: `probe/probe.go:116-175`

## Probe levels

| Level | Meaning | Failure action |
|-------|---------|----------------|
| L2 (alive) | HTTP/DB/TCP liveness | Immediate critical alert |
| L3 (correct) | Functional correctness with observable side-effect | 3 consecutive errors → warning; open > 2h without green → critical |

## Alert escalation rules (Evaluator)

| Condition | Action |
|-----------|--------|
| L2: 1 consecutive `err` | Open alert with severity=`critical` |
| L3: 3 consecutive `err` | Open alert with severity=`warning` |
| Warning alert open > 2h without green | Escalate to `critical` |
| 3 consecutive `ok` or `skip` | Auto-resolve any open/acked alert |

Source: `alert/evaluator.go:26-39`

Alert lifecycle: `open` → `acked` (manual) → `resolved` (auto on 3× OK). Constraint `protection_alerts_layer_level_open_unique` enforces at most one open alert per (layer, level). Source: `alert/evaluator.go:148-159`

## Probe result schema (persisted to `protection_probes`)

| Field | Type | Description |
|-------|------|-------------|
| `layer` | string | e.g. `anti_trace`, `proxy_pool`, `watchdog`, `db_pool`, `sender_engine`, `circuit_breaker`, `canary`, `bounce_guard`, `warmup`, `send_rate`, `header_gate` |
| `level` | int | 2 or 3 |
| `status` | string | `ok`, `warn`, `err`, `skip` |
| `detail` | string | Human-readable result text |
| `latency` | duration | Measured by Scheduler.tickOnce if not set by prober |
| `expected` / `actual` | jsonb | For UI diff display in Ochrany panel |

## Probe layer × level matrix (Ochrany panel)

| Layer | L2 (alive) | L3 (correct) |
|-------|-----------|--------------|
| anti_trace | AntiTraceL2 (30s) | AntiTraceL3 (5min) |
| proxy_pool | ProxyPoolL2 (30s) | ProxyPoolL3 (10min) |
| watchdog | WatchdogL2 (60s) | — (no L3 wired) |
| db_pool | DBPoolL2 (30s) | — (no L3 wired) |
| sender_engine | SenderEngineL2 (60s) | — (no L3 wired) |
| circuit_breaker | — (no L2 wired) | CircuitBreakerL3 (5min) |
| canary | — (no L2 wired) | CanaryL3 (5min) |
| bounce_guard | — (no L2 wired) | BounceGuardL3 (10min) |
| warmup | — (no L2 wired) | WarmupRespectL3 (15min) |
| send_rate | — | SendRateL3 (30min, always SKIP) |
| header_gate | — | HeaderGateL3 (15min) |

## L3 state-machine probe pattern (shadow transactions)

L3 state probes in `probes_l3_state.go` use a **always-rollback transaction**:

1. `BEGIN`
2. `INSERT INTO outreach_mailboxes ... ON CONFLICT DO UPDATE` — upsert shadow mailbox at `probe+state@probe.internal`
3. Execute the state transition under test (UPDATE circuit_opened_at, decrement canary_remaining, etc.)
4. `SELECT` to verify the observable DB state
5. `ROLLBACK` always — no real data is modified

Source: `probe/probes_l3_state.go:29-57`

## BFF surfaces consuming protections

| BFF endpoint | What it reads |
|-------------|--------------|
| `/v1/proxy-pool` | Anti-trace-relay proxy pool health (related; separate from probe) |
| `/api/anti-trace/health` | Anti-trace relay `/v1/health` bridge status |
| Ochrany panel (frontend) | `protection_probes` + `protection_alerts` (unclear which BFF endpoint serves this; not confirmed from read files) |

## Dependencies

| Dependency | What is consumed |
|------------|-----------------|
| `protection_probes` table | All probe results written here |
| `protection_alerts` table | Alert lifecycle rows; constraint `protection_alerts_layer_level_open_unique` |
| `watchdog_events` table | WatchdogL2 reads MAX(created_at) |
| `outreach_config` table | SenderEngineL2 reads `sender_heartbeat_at` key |
| `outreach_mailboxes` table | L3 state probes use shadow row |
| `configs/warmup.yaml` | WarmupRespectL3 loads plan |
| Anti-trace-relay HTTP | AntiTraceL2 (`/healthz`), AntiTraceL3 (`/v1/health`) |
| BFF HTTP | ProxyPoolL2 + ProxyPoolL3 (`/api/proxy-pool?full=1`) |

## Open questions (unresolved as of 2026-05-01)

1. **`Recorder` (Sink) wiring** — which concrete Sink is injected into the Scheduler at boot? `probe/recorder.go` was not read; assume it writes to `protection_probes` but not confirmed.
2. **Ochrany panel BFF endpoint** — what endpoint serves the 12×2 panel cells to the frontend? Not found in the server-routes files read.
3. **`HeaderBuilder` injection** — who provides the `HeaderBuilder` func to `HeaderGateL3`? It takes a `func(...)` interface; the concrete function (sender's `buildMessage`) must be injected at boot in orchestrator/main.go.
4. **L3 state probes and migration drift** — `probes_l3_state.go` references column names (`circuit_opened_at`, `canary_remaining`, `consecutive_bounces`) that must stay in sync with `outreach_mailboxes` schema. No automated drift guard found.

## Cross-references

- Anti-trace map steps O3 (probe scheduler) + O4 (alert evaluator)
- Memory: `project_protection_matrix.md` — 12×2 panel cells; 9 filled by StubProbe skip rows
- `features/inbound/orchestrator/CLAUDE.md` — health surfaces `/health` endpoint
- Initiative: `docs/initiatives/2026-05-01-codebase-awareness-discipline.md`
- Issue: #560
