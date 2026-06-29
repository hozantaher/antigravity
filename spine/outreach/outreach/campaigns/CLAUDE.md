# services/campaigns

> **MANDATORY READ before any code change here:** [`docs/subsystem-maps/anti-trace.md`](../../docs/subsystem-maps/anti-trace.md) — canonical 42-step anti-trace pipeline. Cite its commit SHA in PR description. Bypass paths (direct `sender.NewAntiTraceClient`, raw SMTP, free proxy pool) are banned by audit ratchets:
>
> - `sender/no_bypass_audit_test.go` (CAD-M3) — direct `sender.NewAntiTraceClient` outside `engine.go`. Baseline locked at 0 (verified 2026-05-01 — last bypass site refactored through Engine). New violation → CI red.
> - `sender/airtight_audit_test.go` (ADR-005) — unguarded `smtp.SendMail`/`smtp.Dial`/`net.Dial`/`tls.Dial`. Baseline 0.
>
> To exempt a legitimate site (production wiring): annotate `// engine-bypass-allowed: <reason>` on the line above the call (1-3 lines tolerated).
>
> HARD RULE memory: `feedback_anti_trace_full_stack` (always-loaded T0).

## Stack
Go 1.25, PostgreSQL via `database/sql` + `lib/pq`, no ORM. Test framework: standard `go test` + `sqlmock` for DB, table-driven tests.

## Structure
- `campaign/` — Runner (per-tick orchestration), Scheduler (campaign-level lock + dispatch), advisory-lock audit (BF-E4).
- `sender/` — Send engine (per-mailbox circuit breaker, greylisting backoff, anti-trace-relay client). The retry classifier (`backoff.go`) maps SMTP errors → `SMTPClass` → backoff duration.
- `content/` — Template render + humanize. Plus the cross-mailbox anonymity scorers (`anonymity_score.go` — 4 rules: IP leakage / header fingerprint / envelope match / DKIM-SPF-DMARC; `humanlike_score.go` — Variance + Content + Heuristics). Both pure libraries consumed by `services/orchestrator/cmd/anonymity-{score,humanlike}/`.
- `warmup/` — Per-mailbox warmup plan + ramp logic (cap day-by-day).
- `web/` — HTTP handlers for campaign API + segments (mounted by orchestrator/web).
- `configs/templates/` — Email body templates (`initial.tmpl`, follow-ups). Subject line is the first `{{/* subject: ... */}}` comment.

## Hot files
- `campaign/runner.go` — `RunCampaign` is the per-tick entrypoint. Loops through eligible contacts, renders, enqueues to sender, advances `current_step`. Re-checks `campaigns.status` mid-loop (every `statusCheckEvery` enqueues) so a UI Pause stops within the next batch.
- `campaign/scheduler.go` + `scheduler_postgres.go` — `pg_try_advisory_lock` on campaign_id ensures one runner per campaign across BFF replicas. Audit row in `campaign_lock_audit` (migration 007) for observability — `StaleLockCheck(ttl)` reports holders older than ttl.
- `sender/engine.go` — `Engine.Run` consumes the queue, dispatches via `antitrace.Submit`. Per-mailbox breaker: `mailboxFailThreshold=3`, `mailboxCooldown=30m`. `Engine.ResetMailboxBreaker(addr)` is the explicit half-open trigger from watchdog.
- `sender/antitrace.go` — typed-error sentinels (`ErrAntiTraceRateLimited`, `ErrAntiTraceTransport`, etc.). All wrapped with `%w` so `errors.Is` works on the receiving side.

## Conventions (enforced)
- Every `slog.Error/Warn` carries `"op", "<package>.<func>/<branch>"`. The discipline test in `sender/slog_op_audit_test.go` ratchets violation count down (current baseline: 5 — see test).
- Use `error` key, NOT `err`.
- audit.Log inside `RunCampaign` runs OUTSIDE the per-tick tx — see `runner_audit_contract_test.go` for the locked contract.
- **AT2.3 airtight ratchet** (ADR-005): no unguarded `smtp.SendMail` / `smtp.Dial` / `net.Dial` / `tls.Dial` v `services/campaigns/sender/*.go`. Baseline locked at 0 v `sender/airtight_audit_test.go`. New call site → annotate `// airtight-allowed: <důvod>` na řádku 1-3 nad voláním, NEBO wrap v `if cfg.Sending.TransportMode != "lab" { ... }` gate.

## Testing
- `go test ./...` — 1000+ tests across 5 packages (`campaign`, `sender`, `content`, `warmup`, `web`). Race-clean.
- New code: extreme-testing rule per memory `feedback_extreme_testing.md` — ≥10 test cases per change, boundary + error + integration + property/race when applicable.
- DB-touching code uses sqlmock (`go-sqlmock`).

## Don't
- Don't bypass anti-trace-relay (HARD RULE: SMTP-egress lockdown R4).
- Don't write campaign passwords to env vars (HARD RULE: DB only).
- Don't add new slog calls without `op` field — discipline test will fail.
