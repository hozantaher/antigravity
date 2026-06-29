# slog Field Conventions

> **Created**: 2026-04-25 (BF-F1, BF-F2)
> **Scope**: every Go service writing structured logs via `log/slog`.
> **Why**: Sentry tag mapping + log search aggregation only work when
> services agree on field names.

## Mandatory keys

| Key | When | Type | Notes |
|---|---|---|---|
| `op` | every Error/Warn call | string | `<package>.<func>/<branch-or-condition>` |
| `error` | when reporting an error value | error | NOT `err` — see migration below |

## Common entity keys (use the longer form)

| Use | NOT | Why |
|---|---|---|
| `campaign_id` | `id`, `campaign` | Cross-service log search needs uniqueness |
| `contact_id` | `id`, `contact` | Same |
| `mailbox_id` | `mailbox`, `address` | `mailbox` ok when value is a from-address string; `mailbox_id` for the BIGINT |
| `send_event_id` | `id`, `send_id` | Tracking-pixel & reply-extraction joins |
| `template` | `tmpl` | |
| `step` | `s`, `idx` | |
| `recipient_domain` | `to_domain`, `domain` | `domain` ambiguous — sender vs recipient |
| `duration_ms` | `dur`, `elapsed` | Always milliseconds, integer |

## op naming convention

`<package>.<func>/<branch>` where:
- `package` is the short package name (no path).
- `func` is the function or receiver method.
- `branch` is the specific code branch (e.g. `recover`, `429`, `circuitOpen`).
  Optional but valuable when one func has multiple slog calls.

Examples:
- `engine.recordSendResult/transient`
- `antitrace.Submit/429`
- `scheduler.runOne/lock`
- `runner.RunCampaign/recover`

## Migration log (this pass)

### `err` → `error` standardisation (BF-F1)

slog convention prefers the longer `error` key. `err` is also valid Go
idiom for the variable name, but the slog key should be `error` so log-
search dashboards can group consistently. Migrated:

- `features/outreach/campaigns/sender/engine.go` — 2 sites (generateMessageID,
  randomDelay).
- `features/outreach/campaigns/campaign/scheduler.go` — 5 sites (tick, runOne
  variants).

### `op` field added (BF-F2)

10 sites in `features/outreach/campaigns/sender` (engine.go + antitrace.go).
Discipline test in `slog_op_audit_test.go` keeps the count at <= 5
violations; new code without `op` will fail the test.

## When you need to deviate

If a slog call genuinely doesn't fit the convention (e.g. you don't have
a `campaign_id` because the call is at boot), document the reason in a
comment above the call. Don't invent ad-hoc key names.

Bad:
```go
slog.Warn("queue size", "queue_len", n)  // queue_len not in the table
```

Good:
```go
// Boot-time queue depth check; no campaign/contact context yet.
slog.Warn("queue size at boot", "op", "main.bootQueueAudit", "depth", n)
```

## Sentry mapping

The Sentry processor in `features/platform/common/telemetry/sentry.go` SlogHandler
forwards LevelError records as `Sentry.CaptureException`/`CaptureMessage`
with attrs as Sentry context. Tag fragmentation happens when one service
writes `"campaign_id"` and another writes `"campaign"` — Sentry treats
these as different facets and fingerprint groups split.

This convention file is the single source of truth. When in doubt, grep
for the existing keys in `features/inbound/orchestrator` (164 `error` references,
the dominant baseline) and match.
