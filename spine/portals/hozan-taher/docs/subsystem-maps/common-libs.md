# Subsystem Map — Common Libs (features/platform/common)

**Version:** 2026-05-03
**Owner:** features/platform/common
**Refresh:** 2026-05-03 @ 52ff93d (envconfig BoolOr + sqlsuppression UNION + telemetry release tag)
**Last verified:** 2026-05-03 via deep-read of envconfig/envconfig.go (BoolOr), sqlsuppression/sql.go (UNION), telemetry/sentry.go (release tag); prior baseline 2026-05-01

`features/platform/common` is the dependency-leaf shared library imported by all other Go services in the monorepo. It contains no application-layer imports (`features/outreach/campaigns/*`, `features/inbound/orchestrator/*`) — this rule is enforced by convention and the CLAUDE.md contract. Every package here is used by two or more services.

> **Mandatory read:** before adding a new cross-service helper. Helpers belong here only if used by ≥2 services. New callers of env vars MUST use `envconfig.GetOr`/`Required`/`BoolOr` — the `consumption_audit_test.go` ratchet (T2.7) blocks bare `os.Getenv` growth.

## Subpackages

### audit

| Symbol | File | Description |
|--------|------|-------------|
| `Execer` interface | `audit/log.go:17` | Narrow interface: `ExecContext(ctx, query, args…)`. Accepted by both `*sql.DB` and `*sql.Tx`. |
| `audit.Log` | `audit/log.go:25` | Writes to `operator_audit_log`. Error → slog.Warn, never returned. `db == nil` → no-op. |
| `audit.Recent` | `audit/log.go:51` | Reads `operator_audit_log` newest-first. |
| `audit.LogChannel` | `audit/channel.go:35` | Writes to `channel_audit_log` (migration 019). Best-effort. Normalises `subjectEmail` via RFC 5322 parse. |
| `ChannelEmail` / `DirectionOutbound` / `DirectionInbound` | `audit/channel.go:13-17` | Direction constants. |

`operator_audit_log` schema: `(id, action, actor, entity_type, entity_id, details jsonb, created_at)`.
`channel_audit_log` schema: `(channel, direction, subject_email, message_id, details jsonb, created_at)`.

### calendar

| Symbol | File | Description |
|--------|------|-------------|
| `IsSendableDay(t)` | `calendar/cz.go:80` | True when weekday + not Czech public holiday (zákon 245/2000 Sb.). |
| `CzechCalendar` | `calendar/cz.go:10` | Struct with `IsDeadDay`, `IsReducedDay`, `VolumeMultiplier`. Timezone-aware (Europe/Prague). |
| `IsSendableDay` | `calendar/cz.go:80` | Package-level; used by runner send-window gate (anti-trace map R4). |
| `InSendWindow` | `calendar/sendwindow.go` (not read) | Used by runner R14 (timezone-aware send-window gate). |

Dead days: weekends, Czech holidays, Christmas/New Year dead zone (Dec 22–Jan 2). Reduced days: July, August, bridge Fridays. Source: `calendar/cz.go:29-62`

### config

Typed config structs shared across services. Not read in full but referenced by CLAUDE.md:

| Symbol | Description |
|--------|-------------|
| `SendingConfig` | Includes `TransportMode` enum (`lab|proxy|socks5|tor|vpn|vpn+tor`; `direct` banned). AT2.2 airtight gate. |
| `ValidateAirtight()` | Returns `*AirtightError` with exit codes 47 (lab-only) or 48 (banned mode). Called by `Config.Validate()` at boot. |
| `MailboxConfig` | `IMAPHost`, `IMAPPort`, `Username`, `Password`, `Address`. Used by IMAP poller. |

### db

Connection helpers + retry shims (not read in full). Provides `*sql.DB` construction from `DATABASE_URL`.

### envconfig

| Symbol | File:Line | Description |
|--------|-----------|-------------|
| `Required(keys…)` | `envconfig/envconfig.go:36` | Builds a Schema with required env keys. |
| `MustHave(keys…)` | `envconfig/envconfig.go:81` | One-call form of `MustValidate(Required(…))`. os.Exit(1) on missing. |
| `MustValidate(s)` | `envconfig/envconfig.go:70` | os.Exit(1) if any required key is empty/missing. |
| `OptionalDefault(&s, key, val)` | `envconfig/envconfig.go:47` | Registers optional var; writes default to os.Setenv so downstream os.Getenv calls see it. |
| `GetOr(key, fallback)` | `envconfig/envconfig.go:97` | Canonical replacement for ad-hoc `envOr` helpers. Empty string → fallback. Whitespace-only → returned as-is. |
| `BoolOr(key, fallback)` | `envconfig/envconfig.go:166` | Parses `1/true/yes/on` → true; `0/false/no/off` → false; unknown/empty → fallback. Whitespace-padded values treated as unknown (typo guard). Used by LAB_ONLY + transport-mode gates. |

**T2.7 consumption ratchet** (`consumption_audit_test.go`, baseline 0): scans `services/*/**.go` excluding `_test.go` + `common/envconfig/`. Full migration to `GetOr`/`Required`/`BoolOr` complete (2026-05-01). New callers MUST use these helpers. Annotate `// envconfig-allowed: <reason>` on the line above to exempt.

### health

| Symbol | File | Description |
|--------|------|-------------|
| `Registry` | `health/health.go:17` | Thread-safe daemon status store. |
| `Registry.Report(name, ok, errMsg)` | `health/health.go:32` | Records daemon tick outcome; updates `LastRun`. |
| `Registry.Snapshot()` | `health/health.go:44` | Returns copy of all statuses; used by orchestrator `/health` endpoint. |
| `Registry.AllOK()` | `health/health.go:55` | Returns false if any daemon reported not-OK. |
| `Registry.Stale(maxAge)` | `health/health.go:75` | Returns names of daemons silent for > maxAge (goroutine exit detection). |

### humanize

See `docs/subsystem-maps/content-render.md` for detailed humanize pipeline. Key exports:

| Symbol | File | Description |
|--------|------|-------------|
| `Engine` | `humanize/engine.go:7` | Master orchestrator: Circadian, Imperfect, Tone, Calendar, Fingerprint, Signature, Bump, Response. |
| `NewEngine(persona)` | `humanize/engine.go:31` | Constructor; persona contains Name, Role, Company, Phone, Email, Website, Region. |
| `Engine.PrepareEmail(…)` | `humanize/engine.go:83` | Entry point for email humanization; called as PreSendHook in sender engine G7. |
| `ResponseEngine.ClassifyReply(text)` | `humanize/response.go` (not read) | Keyword-based reply classification (baseline for LLM override). |
| `ReplyType` enum | `humanize/response.go` | `ReplyInterested`, `ReplyMeeting`, `ReplyLater`, `ReplyObjection`, `ReplyNegative`, `ReplyAutoOOO`. |

### maillabclient

HTTP client for mail-lab sandbox (test-only egress):

| Symbol | File | Description |
|--------|------|-------------|
| `Client` | `maillabclient/client.go:47` | HTTP wrapper for mail-lab-api. Auth: `X-Lab-Api-Key` header. Timeout: 10s. |
| `New(baseURL, apiKey)` | `maillabclient/client.go:56` | Constructor. Empty apiKey → no auth header. |
| `ErrUnknownDomain` / `ErrUnauthorized` / `ErrBadRequest` | `maillabclient/client.go:35-43` | Typed error sentinels for callers to `errors.Is`. |

### metrics

Prometheus registry + counters/gauges. Not read in detail; provides `metrics.Registry` and outreach-specific metric definitions.

### refreshcron

Per-source refresh cron backoff state (KT-A10):

| Symbol | File | Description |
|--------|------|-------------|
| `LoadConfigFromEnv(prefix, defaultInterval)` | `refreshcron/state.go:100` | Reads `{prefix}_REFRESH_INTERVAL`, `_BACKOFF_CAP`, `_BACKOFF_MULTIPLIER`. |
| `LoadState(ctx, db, source)` | `refreshcron/state.go:154` | Reads `refresh_cron_state` row; returns zero-value on first call. |
| `RecordResult(ctx, db, cfg, result, now)` | `refreshcron/state.go:223` | Upserts `refresh_cron_state`; success → reset multiplier; failure → ramp × 1.5, bounded by cap. |
| `ShouldRun(state, cfg, now)` | `refreshcron/state.go:354` | Returns true when now ≥ next_run_at. |
| `TryLock(ctx, db, source)` | `refreshcron/state.go:306` | `pg_try_advisory_lock` per source — prevents parallel refresh on multiple replicas. |
| `Unlock(ctx, db, source)` | `refreshcron/state.go:315` | Releases lock. Best-effort (auto-releases on session close). |
| `EmitBreadcrumb(state, cfg, result, batchSize)` | `refreshcron/state.go:329` | Sentry breadcrumb per tick. |

### sqlsuppression

| Symbol | File | Description |
|--------|------|-------------|
| `UnionSelect` | `sqlsuppression/sql.go:36` | Inner SELECT producing `lower(trim(email))` from both suppression tables (outreach_suppressions ∪ suppression_list). |
| `NotInUnionWhere(col)` | `sqlsuppression/sql.go:50` | Canonical NOT-IN fragment for eligible-contacts SELECT. Interpolates column name as literal. |
| `CountUnionSQL` | `sqlsuppression/sql.go:59` | COUNT query against union; used by preflight P2 gate. |
| `EnsureContainsBothTables(sql)` | `sqlsuppression/sql.go:69` | Discipline helper: returns true iff sql contains both table names + UNION keyword. Used by runner + preflight test suites to prevent accidental one-table refactors. |

**UNION mandatory.** Every read-side call site (eligibility check, suppression audit, preflight) MUST use both tables via the shared `UnionSelect` fragment. Normalization (lower+trim) prevents email case/whitespace drift between Go and JS writers. **PR #639 (S1.1)** added `suppression_sync_test.go` to enforce bidirectional mirroring: inserts to `suppression_list` (JS/UI) → mirrored to `contacts.status='suppressed'`. JS mirror: `features/platform/outreach-dashboard/src/lib/suppressionUnionSql.js`. See memory `project_two_suppression_tables.md`.

### telemetry

| Symbol | File | Description |
|--------|------|-------------|
| `Init(service)` | `telemetry/sentry.go:77` | Initializes Sentry from `SENTRY_DSN_GO`. No-op when empty. Release tag auto-derived via `BuildReleaseTag(service)`. |
| `BuildReleaseTag(service)` | `telemetry/sentry.go:100` | Produces `<service>@<sha7>` from `GIT_SHA`, then fallback to `RAILWAY_GIT_COMMIT_SHA`, then `SOURCE_COMMIT` env vars. Used by `Init()` + explicitly called in each service's main.go. |
| `MonitoredJob(slug, fn)` | `telemetry/sentry.go:20` | Wraps periodic job with Sentry cron check-in (in_progress → ok/error). Recovers panics. |
| `SlogHandler` | `telemetry/sentry.go:122` | slog handler that forwards LevelError to Sentry. |
| `SetServiceTag(name)` | `telemetry/sentry.go:265` | Sets `service` Sentry tag post-Init. |
| `HTTPRecoveryMiddleware` | `telemetry/sentry.go:184` | Recovers HTTP handler panics, captures to Sentry, returns 500. |
| `Flush()` | `telemetry/sentry.go:116` | Blocks up to 2s to drain Sentry queue before process exit. |

### token

| Symbol | File | Description |
|--------|------|-------------|
| `BuildUnsubToken(campaignID, contactID, email, secret)` | `token/unsub.go:37` | HMAC-SHA256(`secret`, `"<cid>\|<id>\|<email>"`) → hex[:16]. |
| `VerifyUnsubToken(campaignID, contactID, email, received, secret)` | `token/unsub.go:50` | Constant-time compare via `hmac.Equal`. |

Wire format is locked by `runner_unsub_token_test.go` (Go) and `bff-unsubscribe.contract.test.ts` (JS). JS twin: `features/platform/outreach-dashboard/src/lib/unsubToken.js`.

## Dependency graph (leaf position)

`features/platform/common` has **no imports from application-layer packages**. Every other Go service (`campaigns`, `orchestrator`, `contacts`, `mailboxes`, `relay`) imports from `common`. This is a hard architectural constraint enforced by the CLAUDE.md contract.

## Ratchets (discipline tests)

- **`envconfig.consumption_audit_test.go`** (T2.7) — enforces zero bare `os.Getenv` calls in production code. All callers must use `GetOr`/`Required`/`BoolOr`.
- **`sqlsuppression.EnsureContainsBothTables`** — used by runner + preflight test suites to verify both suppression tables are present in every WHERE clause.
- **`slog_op_audit_test.go`** (in `features/outreach/campaigns/sender/`) — sibling ratchet that enforces `op` field presence in all slog calls; common-libs does not implement this, but exported slog helpers must cooperate with it.

## Open questions (unresolved as of 2026-05-01)

1. **`invariant` package** — listed in CLAUDE.md but no source file read. Purpose: runtime invariant checkers (post-condition asserts; fail-loud instead of silent drop). Impact unclear.
2. **`alert/webhook.go`** — alert dispatch + dedup primitives. Not read in detail; relationship to `protection_alerts` evaluator unclear.
3. **`auditbuild/slogop`** — `scanner.go` appears to be a build-time scanner for slog `op` field compliance. Not read; likely implements the slog_op_audit_test discipline.

## Cross-references

- Anti-trace map: `sqlsuppression` (step R5), `token` (step R12), `audit.LogChannel` (step O2), `calendar` (steps R4, R14)
- IMAP inbound map: `audit.LogChannel` (step P10), `humanize.ResponseEngine.ClassifyReply`
- Content render map: `humanize.Engine.PrepareEmail` (step G7)
- Memory: `project_two_suppression_tables.md`, `project_bf_g_ops_tooling.md`
- Initiative: `docs/initiatives/2026-05-01-codebase-awareness-discipline.md`
- Issue: #560
