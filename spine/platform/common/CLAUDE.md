# services/common

## Stack
Go 1.25, no external deps beyond stdlib + sentry-go + prometheus client. Test: `go test`.

## Purpose
Cross-service shared library — every other Go service depends on it.
Anything reused by 2+ services lives here.

## Subpackages
- `alert/` — alert dispatch + dedup primitives
- `audit/` — `audit.Log(ctx, db, action, actor, entityType, entityID, details)` writes to `operator_audit_log`. `Execer` interface accepts both `*sql.DB` and `*sql.Tx` so callers choose tx scope.
- `calendar/` — Czech business-calendar (holidays, send windows, DST-correct timezones).
- `config/` — typed config structs shared across services (`SendingConfig`, `SafetyConfig`, `MailboxConfig`). **AT2.2 airtight gate** (ADR-005): `SendingConfig.TransportMode` enum (`lab|proxy|socks5|tor|vpn|vpn+tor`; `direct` banned) + `LabOnly bool`. `ValidateAirtight()` returns `*AirtightError` with `ExitCode` 47 (lab-only mismatch) or 48 (banned/unknown mode). `Config.Validate()` calls it first — fail-fast even bez authenticated mailboxes.
- `db/` — connection helpers + retry shims.
- `envconfig/` — **BF-G4**: boot-time env-var validation. `Required(...)` builds a schema; `MustValidate(s)` os.Exits on missing; `MustHave(...)` is the one-line form. PR #406 added canonical `GetOr(key, fb)` + `BoolOr(key, fb)` consumption API. **T2.7 consumption ratchet** (`consumption_audit_test.go`): scans `services/*/**.go` (excluding `_test.go` + `common/envconfig/` itself) and fails if bare `os.Getenv` count rises above the locked baseline (currently `0`, verified 2026-05-01 — full migration complete). New callers MUST use `envconfig.GetOr` / `Required` / `BoolOr`. To bypass: annotate `// envconfig-allowed: <důvod>` on the line directly above the call (1–3 lines or same-line trailing). To lower the baseline: migrate calls, run the test locally, update `consumptionAuditBaseline`.
- `health/` — daemon health registry consumed by orchestrator/web `/health`.
- `humanize/` — email humanization fingerprints (Message-ID, headers).
- `invariant/` — runtime invariant checkers (post-condition asserts; fail-loud místo silent drop).
- `maillabclient/` — klient pro mail-lab sandbox (test-only egress).
- `metrics/` — Prometheus registry + counters/gauges.
- `refreshcron/` — sdílený scheduler wrapper pro periodické refresh joby (kotvený v BFF/orchestrator).
- `telemetry/` — Sentry init, slog→Sentry handler, monitored-job wrapper, **BF-F3** `BuildReleaseTag(service)` for `<service>@<sha>` from GIT_SHA env.
- `token/` — canonical HMAC-SHA256 unsubscribe-token helpers (`BuildUnsubToken`, `VerifyUnsubToken`). Used by `services/campaigns/campaign/runner.go` (token emit at send time) and the BFF `/unsubscribe` handler in `apps/outreach-dashboard/server.js` via the JS twin at `apps/outreach-dashboard/src/lib/unsubToken.js`. Wire format `HMAC-SHA256(secret, "<cid>|<id>|<email>") → hex[:16]` is locked by both sides' test suites.

## Conventions
- Every export has a doc comment.
- Public APIs accept interfaces, not concrete types (e.g. `audit.Execer` rather than `*sql.DB`).
- No global state — pass dependencies via constructor.

## Testing
- `go test ./...` — 600+ tests napříč 13 packages.
- New cross-cutting helper goes here only if it's used by ≥2 services.

## Don't
- Don't import application-layer packages (`services/campaigns/*`, `services/orchestrator/*`) — common is a leaf in the dependency graph.
- Don't add hard-coded service names; use parameters (e.g. `BuildReleaseTag(service)`).
