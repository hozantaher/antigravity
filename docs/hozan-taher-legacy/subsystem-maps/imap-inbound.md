# Subsystem Map — IMAP Inbound + Reply Ingestion

**Version:** 2026-05-02
**Refresh:** 2026-05-02 @ e4487ee8 (WATCHDOG-GO: poller moved to orchestrator daemon)
**Owner:** features/inbound/orchestrator/imap + features/inbound/orchestrator/thread
**Last verified:** 2026-05-02 via deep-read of imap/poller.go, cmd/outreach/main.go:700–747, thread/inbound.go, thread/manager.go, intelligence/mailbox_score_loop.go

This document is the canonical map of the IMAP polling → reply classification → thread-state transition pipeline. Any code that reads inbound email from mailboxes or routes replies to threads MUST flow through this stack.

> **Mandatory read:** before any code change in `features/inbound/orchestrator/imap/`, `features/inbound/orchestrator/thread/`, or `features/inbound/orchestrator/llm/classify.go`.

## Components

| Component | File | Role |
|-----------|------|------|
| `Poller` struct | `features/inbound/orchestrator/imap/poller.go:30` | IMAP daemon: per-mailbox polling, dedup LRU, reconnect loop |
| `NewPoller` | `features/inbound/orchestrator/imap/poller.go:50` | Constructor: wires mailboxes + InboundProcessor |
| `PollOnce` | `features/inbound/orchestrator/imap/poller.go:119` | Single poll cycle across all mailboxes |
| `PollDaemon` | `features/inbound/orchestrator/imap/poller.go:231` | Ticker loop, calls PollOnce at configured interval |
| `fetchNewMessages` / `doFetch` | `features/inbound/orchestrator/imap/poller.go:272` | TCP/TLS connection + IMAP session per mailbox |
| `parseFetchResponse` | `features/inbound/orchestrator/imap/poller.go:538` | IMAP literal parser → `thread.RawInbound`; prefers BODY[] full RFC822 over legacy split-body fallback |
| `InboundProcessor` | `features/inbound/orchestrator/thread/inbound.go:60` | Routes RawInbound: bounce detection → reply classification → thread state + suppression |
| `ProcessReply` | `features/inbound/orchestrator/thread/inbound.go:130` | Entry point: match thread → detect bounce → classify → record → act |
| `matchToThread` | `features/inbound/orchestrator/thread/inbound.go:413` | DB lookup via In-Reply-To and References headers |
| `DetectBounce` | `features/inbound/orchestrator/thread/bounce.go` (not read; cited by inbound.go:146) | DSN / MAILER-DAEMON detection gate |
| Keyword classifier | `features/platform/common/humanize/response.go` | `response.ClassifyReply` — deterministic keyword-based baseline |
| LLM classifier | `features/inbound/orchestrator/llm/classify.go:118` | `ClassifySentiment` — Anthropic prompt override (6 categories) |
| `Manager` | `features/inbound/orchestrator/thread/manager.go:52` | Thread lifecycle: Create, Pause, Close, MarkReplied, AdvanceStep, ExpireStaleThreads |
| `audit.LogChannel` | `features/platform/common/audit/channel.go:35` | Track E (migration 019) inbound channel_audit_log write |

## Poll cycle detail (per mailbox)

| # | Step | File:Line | Notes |
|---|------|-----------|-------|
| P1 | Skip mailbox if `IMAPHost == ""` or `IMAPPort == 0` | `poller.go:123` | config guard |
| P2 | `fetchNewMessages` → `runWithReconnect` + `doFetch` | `poller.go:276` | exponential backoff 1s→5min on transient errors |
| P3 | TCP dial with 10s timeout; TLS on port 993 via `DialContext` + `HandshakeContext` | `poller.go:363-407` | F4-2 fix — both layers honor context cancellation |
| P4 | IMAP LOGIN + SELECT INBOX + NOOP | `poller.go:296-306` | |
| P5 | `SEARCH UNSEEN SINCE <date>` — date in UTC format | `poller.go:316-319` | F4-3 fix — force UTC so date doesn't drift on non-UTC deployments |
| P6 | `FETCH <uid> BODY.PEEK[]` per UID (full RFC822, no \Seen flag) | `poller.go:489` | 25 MB cap via `MAIL_MAX_SIZE_BYTES`; oversized messages dropped at `poller.go:549` |
| P7 | `parseFetchResponse` → `RawInbound` | `poller.go:538` | prefers full BODY[] literal; falls back to split BODY[HEADER.FIELDS]+BODY[TEXT] then double-CRLF split |
| P8 | Dedup via `isSeen` (50k FIFO LRU) | `poller.go:142` | keyed by Message-ID; UID-based fallback for messages without ID |
| P9 | `processor.ProcessReply(ctx, msg)` | `poller.go:147` | |
| P10 | `audit.LogChannel` Track E | `poller.go:163` | best-effort; nil auditDB → skip |
| P11 | `health.Registry.Report("imap_poll", …)` | `poller.go:182` | feeds `/health` surface |

## ProcessReply detail

| # | Step | File:Line | Effect |
|---|------|-----------|--------|
| R1 | `matchToThread` — In-Reply-To then References | `inbound.go:413` | returns (threadID, contactID); 0 = no match → return nil |
| R2 | `DetectBounce` — DSN/MAILER-DAEMON gate | `inbound.go:146` | must run BEFORE classifier; DSNs phrase like "interested" |
| R3 | Keyword classify `response.ClassifyReply` | `inbound.go:162` | deterministic; always runs first |
| R4 | LLM `classifier.ClassifySentiment` (optional) | `inbound.go:165-190` | overrides keyword on parseable result; falls back to keyword on error or unparseable |
| R5 | `parseRawIfPresent` — MIME parse if `RawBytes` present | `inbound.go:197` | best-effort; error logged, processing continues with partial result |
| R6 | `recorder.RecordInbound` | `inbound.go:200` | writes to `outreach_messages`; includes body_plain, body_html, attachments, sentiment |
| R7 | Photo pipeline (optional `PhotoProcessor`) | `inbound.go:222` | best-effort; failures never abort inbound |
| R8 | `events.LogReplied` | `inbound.go:227` | event log write |
| R9 | Branch on `replyType` | `inbound.go:230-283` | see table below |

### Reply type → action

| Type | Action | Suppression | Lead |
|------|--------|-------------|------|
| `ReplyNegative` | `Manager.Close` + `events.LogComplained` | INSERT INTO outreach_suppressions (`inbound.go:241`) | — |
| `ReplyAutoOOO` | `Manager.Pause` 14 days | — | — |
| `ReplyLater` | `Manager.Pause` 30 days | — | — |
| `ReplyMeeting` | `Manager.MarkReplied(ActionManualFollow)` + `onInterested` hook | — | upsert leads |
| `ReplyInterested` | `Manager.MarkReplied(ActionWaitReply)` + `onInterested` hook | — | upsert leads |
| `ReplyObjection` | `Manager.MarkReplied(ActionWaitReply)` | — | — |

### Bounce processing (`processBounce`)

| Step | File:Line | Effect |
|------|-----------|--------|
| Record DSN inbound | `inbound.go:302` | `outreach_messages` |
| Mark outbound message bounced | `inbound.go:338` | UPDATE bounced_at + smtp_response |
| Hard bounce → thread status=`bounced` | `inbound.go:353-358` | |
| Soft bounce → Pause 3 days | `inbound.go:361` | |
| `events.LogBounced` | `inbound.go:369` | increments contact + domain bounce counters |
| Hard bounce → contact status=`bounced` | `inbound.go:377` | |
| Hard bounce → `bounceRecorder.RecordBounce` | `inbound.go:391` | F3-1: feeds mailbox backpressure auto-hold |

## Polling scheduler (orchestrator daemon)

**PR #370 (WATCHDOG-GO, 2026-05-01)** migrated IMAP polling from BFF cron to Go orchestrator daemon goroutine.

| Step | File:Line | Notes |
|------|-----------|-------|
| Boot wiring | `cmd/outreach/main.go:700–747` | Called in `case "server":` when `len(cfg.Mailboxes) > 0` and not `DISABLE_IMAP_POLL=1` |
| Construct InboundProcessor | `main.go:708` | `thread.NewInboundProcessor(database)` — wires photo processor, LLM classifier, interested hook |
| Construct Poller | `main.go:724–726` | `imapPkg.NewPoller(cfg.Mailboxes, imapProcessor).WithHealth(...).WithAuditDB(...)` |
| Spawn daemon goroutine | `main.go:731–741` | Wrapped in `go func()` with panic recovery; calls `PollDaemon(ctx, imapInterval)` with default 2min interval (configurable via `IMAP_INTERVAL`) |
| Interval from env | `main.go:702–706` | `IMAP_INTERVAL` env var; parsed as Go duration; fallback 2m |
| Daemon loop | `imap/poller.go:231–260` | `for range ticker.C: select case <-ctx.Done(): return; case: PollOnce()` |
| Poll cycle | `imap/poller.go:119–194` | Per-mailbox IMAP session; UID watermark lookup (SQL); SEARCH UNSEEN + FETCH; dedup via Message-ID LRU (50k cap); route to InboundProcessor |

## Public API consumed by

| Consumer | Entry point |
|----------|-------------|
| Orchestrator daemon (boot-time) | `Poller.PollDaemon(ctx, interval)` started in `cmd/outreach/main.go:740` |
| Dashboard replies UI | GET `/api/replies` reads `outreach_messages` directly (via `src/server-routes/replies.js`) |
| BFF sentiment suggestion | `/api/replies/:id/ai-suggestion` reads `outreach_messages.body_plain` |

## Dependencies

| Dependency | What is consumed |
|------------|-----------------|
| `features/platform/common/audit` | `audit.LogChannel`, `audit.Execer` |
| `features/platform/common/config` | `config.MailboxConfig` (IMAPHost, IMAPPort, Username, Password) |
| `features/platform/common/health` | `health.Registry.Report` |
| `features/platform/common/humanize` | `ResponseEngine.ClassifyReply`, `ReplyType` enum |
| `features/inbound/orchestrator/llm` | `Client.ClassifySentiment` (optional override) |
| `features/inbound/orchestrator/mime` | `mime.Parse(rawBytes)` — MIME tree extraction |
| DB tables | `outreach_messages`, `outreach_threads`, `outreach_contacts`, `outreach_suppressions`, `channel_audit_log` |

## Forbidden bypasses

| Bypass | Why banned |
|--------|-----------|
| Writing to `outreach_suppressions` without going through `ProcessReply` on negative reply | Breaks dual-table suppression contract; run's pre-send filter covers `sqlsuppression` UNION |
| Calling `matchToThread` directly and skipping `DetectBounce` gate | DSN messages misclassify as "interested" without the bounce gate |
| Calling `ClassifySentiment` without keyword fallback | LLM errors would silently drop reply classification |

## Resolved (2026-05-02)

1. **`onInterested` hook wiring** — `main.go:721–722` wires `imapProcessor.WithInterestedHook(func(...) { imapAlertClient.InterestedReply(...) })` so interested replies trigger alert webhooks.
2. **Polling scheduler relocation** — PR #370 moved `PollDaemon` from BFF `runFullCheckCron` to orchestrator goroutine (WATCHDOG-GO). Polling now runs 24/7 on Railway, independent of BFF cron.
3. **Mailbox score loop relocation** — `intelligence/mailbox_score_loop.go` (wired `main.go:755`) runs every 4h (configurable via `MAILBOX_SCORE_INTERVAL`), writing `last_score` + `last_score_at` to `outreach_mailboxes`. Moved from BFF in CAD-S8 (issue #539).

## Open questions (unresolved as of 2026-05-02)

1. **IMAP credential source** — poller reads `config.MailboxConfig.Password` at boot; if mailbox password is rotated in DB, the poller continues with the stale boot-time config until restart. No hot-reload path. (See dashboard mailbox CRUD at `src/server-routes/mailboxes.js`.)
2. **`WithBounceRecorder` wiring** — `ProcessReply` calls `bounceRecorder.RecordBounce` (line 391); is `StoreBackpressure` (features/outreach/mailboxes) wired into the orchestrator boot? Not confirmed from current code.
3. **Seen-LRU persistence** — `seenList` is in-process memory. Restart loses the set; duplicate processing risk within `lastPoll` window on restart. Acceptable for now (F4-1 fix was unbounded leak).

## Cross-references

- Anti-trace map step O1: `features/inbound/orchestrator/imap/` is the O1 observability goroutine
- Memory: `project_two_suppression_tables.md` — both suppression tables must be union-queried
- Mailbox scoring: `intelligence/mailbox_score_loop.go` (4h interval, moved from BFF in CAD-S8 / #539)
- Initiative: `docs/initiatives/2026-05-01-codebase-awareness-discipline.md` (CAD-A1 subsystem maps)
- Initiative: `docs/initiatives/2026-05-02-post-cleanup-hardening.md` (S2.3 map refresh)
- PR #370: WATCHDOG-GO — poller daemon relocation to orchestrator (2026-05-01)
- Issue: #560 (subsystem map requirement)
