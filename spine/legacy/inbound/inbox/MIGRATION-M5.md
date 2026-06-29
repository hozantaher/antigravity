# M5 Inbox Migration Plan

**Status (2026-04-23):** M5.1 done (scaffold) ✅, M5.2a-b done (imap + thread public) ✅, **M5.3 reply detail web handler carve ✅** (services/inbox/web/threads.go), **M5.4 go.mod ✅** (services/inbox/go.mod registered). M5.2c pending (reply classification slice). Owner: tomas. Target: 2026-04-29.

Additional inbox web handlers (/api/inbox list, /api/threads/:id/context,
/api/threads/:id/messages) are NOT yet registered in outreach/web/server.go
— they'll be added as they're implemented in the inbox service per M5.
Currently the only carved inbox route is `POST /api/replies/:id/reply`.

**M-prep COMPLETE** — all 18 packages out of `modules/outreach/internal/`.
Includes imap, thread, llm (reply classification), web (server + handlers),
intelligence. M5.2c/M5.3 are no longer blocked by Go internal/ visibility
— they now depend only on Server-struct dependency-injection refactor.

## Goal

Migrate inbox-related Go packages out of `modules/outreach/internal/` into
`services/inbox/` per same pattern as M1 (mailboxes) and M4 (contacts).
Preserve all tests (TDD baseline same-count).

## Source packages

| Pkg                            | LoC   | Tests | Owner-after | Notes                       |
|--------------------------------|------:|------:|-------------|-----------------------------|
| `modules/outreach/internal/imap`   | 2737  | 5     | inbox/imap   | IMAP poller + UID dedup    |
| `modules/outreach/internal/thread` | 1941  | 5     | inbox/thread | thread resolver + merging  |
| `modules/outreach/internal/classify` (reply slice) | TBD | TBD | inbox/reply | reply classification only — split from ICP |

ICP/sector/region classification stays in `outreach` until M4.4 (contacts
enrichment slice). Only the reply-classification surface comes here.

## Phased rollout

### M5.2a: imap → services/inbox/imap

**TDD**: count tests in `imap/` = 5 → after move = 5.

```bash
git mv modules/outreach/internal/imap services/inbox/imap-staging
# imports rewrite — but imap is consumed by intelligence + cmd, both inside outreach;
# need to expose services/inbox/imap as a Go module replace
```

Blocker pattern: `intelligence` imports `outreach/internal/imap`. Two options:

1. **Promote first**: move `imap` to `modules/outreach/imap` (public), then
   `git mv` to `services/inbox/imap` with `replace` directive in
   `modules/outreach/go.mod`. Pattern proven by M1a.2 (mailboxes/registry).
2. **Lift consumer**: move intelligence loop to `services/inbox` too. Bigger
   blast radius — defer.

**Pick option 1.**

### M5.2b: thread → services/inbox/thread

Same pattern as M5.2a. Thread depends on `humanize` (already public ✅).

### M5.2c: reply classification slice

Carve out `classify/job.go::ClassifyReply()` and supporting helpers into
`services/inbox/reply`. Leave ICP/sector/region behind for M4.4.

This requires a careful split — current `classify` package mixes reply +
company classification. Pre-M5.2c task: identify slice with `go list -deps`.

### M5.3: REST handlers

Move `web/server.go` handlers for `/api/inbox/*`, `/api/replies/*`,
`/api/threads/*` into `services/inbox/internal/web`. The dashboard-shell
keeps top-level Express BFF; only Go-side ownership shifts.

### M5.4: separate go.mod

Once code lives entirely in `services/inbox/`, add `go.mod` + register in
root `go.work`. Pattern proven in services/mailboxes M1d.

## Test invariants

- Total Go test count in repo MUST not decrease across any M5.x commit.
- All package boundaries respect Go internal/ rule (no cross-module
  internal/ imports).
- Each M5.x phase ships in a single commit referenced from the BOARD
  Cross-branch signals.

## Out of scope for M5

- Intelligence loop migration (defer to M5.5 or its own milestone)
- Honeypot pkg (separate domain, defer)
- Bounce-back inbound parsing — already in services/mailboxes/bounce

## Cross-branch signals

- A → B: `Needs-Tests: services/inbox/imap M5.2a regression suite`
- A → B: `Needs-Tests: services/inbox/thread M5.2b regression suite`
- B → A: `Resolves-Trailer: Needs-Tests: services/inbox/imap`
