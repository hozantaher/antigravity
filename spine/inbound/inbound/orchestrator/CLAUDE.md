# services/orchestrator

## Stack
Go 1.25, PostgreSQL via `database/sql` + `lib/pq`, Sentry (telemetry), `net/http` + `http.ServeMux`. Test: `go test` + `sqlmock`.

## Structure
- `cmd/outreach/main.go` — boot. Calls `telemetry.Init("outreach")` (release tag derived from GIT_SHA) and wires the HTTP server.
- `cmd/anonymity-test/` — CLI dispatcher for the cross-mailbox anonymity test (4 senders × 3 receivers × 3 templates = 36 directed sends with `X-Test-Run-ID` header). Reuses `antitrace.Submit` — same egress path as production runner. See `docs/playbooks/anonymity-test-run.md`.
- `cmd/anonymity-harvest/` — IMAP harvester for the 36 delivered messages; persists raw headers + body + DKIM/SPF/DMARC results to `anonymity_test_messages`. Hand-rolled TCP/TLS IMAP client mirroring `imap/poller.go`.
- `cmd/anonymity-score/` — Rule-based anonymity scorer (L1 IP leakage 50pts + L2 header fingerprint 20pts + L3 envelope match 10pts + L4 DKIM/SPF/DMARC 20pts). Persists to `anonymity_test_messages.anonymity_score`. Writes `reports/anonymity/<run-id>/scores.json` + `summary.md`.
- `cmd/anonymity-humanlike/` — Variance + content + heuristics scorer for human-likeness (Variance 30 + Content 50 + Heuristics 20). Per-template aggregation. Writes `humanlike.json` + `humanlike.md`. LLM-judge stub at -1 (phase 2).
- `web/` — HTTP surface: open-pixel `/o`, click-redirect `/c`, dashboard `/dashboard`, health `/health` (with optional `WithHealthSurfaces` extensions for stale advisory locks, queue depth, greylist queue), DSR endpoints, contact-import, campaign API (delegated to `services/campaigns/web/`).
- `imap/` — Mailbox poller. UID watermark + uidValidity-aware delta detection. The pure delta-fn lives in `apps/outreach-dashboard/src/lib/automation.js` (`computeImapNewUids`); Go side wraps it for poller scheduling.
- `internal/photostore/` — Railway volume persistence for inbound photo attachments (Track E, photo_parse_audit). Stores raw image blobs under `{root}/{thread_id}/{message_id}/{filename}` with atomic write-temp-rename semantics. Integration tests verify volume mount, retention, and cleanup hooks for DSR handlers.
- `intelligence/` — 6h analytics loop (open/click rate aggregation, segmentation).
- `protections/` — anti-bot heuristics, suppression checks at boot.
- `honeypot/`, `llm/`, `mailsim/` — supporting tooling.

## Hot files
- `web/server.go` — main HTTP wiring. `recordTrackingEvent` (BF-D4) gates INSERT on `EXISTS (SELECT 1 FROM send_events WHERE id=?)` so bogus tokens don't pollute `tracking_events`.
- `web/handler_dsr.go` — GDPR Article 15 (access) + Article 17 (erasure). 8-table aggregate read, cascade write. Audit-logged.
- `imap/poller.go` — long-running goroutine; honors context cancel + exponential backoff on transient errors.

## Health surfaces (BF-F4)
`/health` returns `status`, `uptime_seconds`, `db`, `daemons`, plus optional fields when wired via `Server.WithHealthSurfaces({...})`:
- `stale_advisory_lock_ids: []int64` — campaign IDs holding locks past TTL. Non-empty flips overall status to `degraded`.
- `pending_envelopes: int` — anti-trace-relay queue depth (sender back-pressure signal).
- `greylist_queue_depth: int` — `email_verify_queue` rows due before now.

## Conventions (enforced)
- Same as `services/campaigns`: `op` field on every slog.Error/Warn; `error` not `err`; release tag via `telemetry.BuildReleaseTag`.
- HTTP handlers always serve a response — pixel/redirect endpoints never propagate DB errors to the client (they return the GIF / 302 regardless and slog the failure).

## Testing
- `go test ./...` — 1500+ tests across 12 packages.
- `web/health_surfaces_test.go` (BF-F4) covers the optional surfaces with mocks.

## Env
- `DATABASE_URL` — required at boot. Will use `common/envconfig.MustHave(...)` once main.go migrates.
- `SENTRY_DSN_GO` — optional; absence is no-op.
- `GIT_SHA` / `RAILWAY_GIT_COMMIT_SHA` — picked up by `telemetry.BuildReleaseTag` for Sentry release dashboards.
- `PHOTO_VOLUME_DIR` — optional; path to Railway persistent volume mount (default `/data/photos`). Mounted as `[[volumes]]` with size `10Gi` in `railway.toml` (retains ~20 months of photos at 10 new campaigns/month baseline).

## Don't
- Don't write to `tracking_events` without the `EXISTS` guard (BF-D4).
- Don't return DB errors from `/o` or `/c` — clients never see them; just slog.
- Don't add slog calls without `op` — drift will leak into Sentry grouping.
