# Subsystem Map — Bounce Handling

**Version:** 2026-05-06
**Refresh:** 2026-05-06 @ HEAD (H3.3 hardening verification)
**Owner:** features/inbound/orchestrator/thread + features/outreach/mailboxes/bounce
**Last verified:** 2026-05-06 via deep-read of thread/bounce.go, thread/inbound.go, mailboxes/bounce/processor.go, imap/poller.go

Trigger for this map: S3 segment expansion blocker — bounce pipeline never validated on production data per H3 hardening. New `testdata/` fixture corpus (H3.2) validates the parser against RFC 3464 DSN format.

> **Mandatory read:** before any code change in `features/inbound/orchestrator/thread/bounce.go`, `features/inbound/orchestrator/thread/inbound.go`, `features/outreach/mailboxes/bounce/processor.go`, or any code that writes to `bounce_events`, `blacklist`, or `contacts.status`.

---

## Architecture

```
[Recipient MTA]
   | DSN bounce (RFC 3464 multipart/report)
   v
[Sender mailbox IMAP inbox]   ← DSN delivered here because Return-Path: <sender>
   | IMAP FETCH (every 2 min)
   v
[features/inbound/orchestrator/imap/poller.go]   PollOnce → fetchNewMessages
   | raw MIME message bytes
   v
[features/inbound/orchestrator/thread/inbound.go]  InboundProcessor.Process
   | DetectBounce(raw RawInbound) BounceInfo
   v
[features/inbound/orchestrator/thread/bounce.go]   regex-based DSN parser
   | BounceInfo{Kind, DSNCode, Diagnostic, FailedRecipient}
   |
   +-- if IsBounce() == false ──→ reply classifier (not a bounce)
   |
   v
[InboundProcessor.processBounce()]         (thread/inbound.go:313)
   |
   +── Step 1: RecordInbound → outreach_messages row (type=bounced)
   +── Step 2: UPDATE outreach_messages SET bounced_at + smtp_response
   +── Step 3: UPDATE outreach_threads (hard→bounced/done, soft→paused 3d)
   +── Step 4: EventLogger.LogBounced → thread_events + bounce counters
   +── Step 5: (hard only) UPDATE outreach_contacts SET status='bounced'
   +── Step 6: (hard only) Backpressure.RecordBounce → mailbox auto-hold
   |
   v
[features/outreach/mailboxes/bounce/processor.go]   Processor.Process (separate path)
   | used by campaigns sender for SMTP-level bounces (not IMAP DSNs)
   |
   +── INSERT bounce_events (send_event_id, contact_id, type, code, reason)
   +── UPDATE send_events SET status='bounced'
   +── (hard) UPDATE contacts SET status='bounced'
   +── (hard) INSERT blacklist (email, reason='hard_bounce')
   +── (hard) UPDATE companies SET email_status='invalid'
   +── (hard) UPDATE outreach_threads SET status='error'
   +── (soft, count>=2) UPDATE outreach_threads SET status='paused' 7d
   +── (soft, count>=3) UPDATE companies SET email_status='risky'
   +── (soft, count>=5) UPDATE companies SET email_status='invalid'
   +── (hard/complaint) Backpressure.RecordBounce → mailbox counter
```

---

## Step-by-step pipeline (IMAP DSN path — primary production flow)

**Step 1 — Recipient MTA emits DSN.**
The remote MTA for the failed recipient returns a Delivery Status Notification
per RFC 3464. The DSN is a `multipart/report; report-type=delivery-status`
message with three MIME parts: human-readable text, `message/delivery-status`
(machine-readable status fields), and `message/rfc822` (original headers).
The Return-Path is `<>` (empty); the DSN is addressed to the original sender.

**Step 2 — DSN arrives in sender mailbox.**
Because the outbound message was sent from a mailbox we own (e.g.
`sender@seznam.cz`), the DSN is delivered to that same IMAP inbox. No special
DSN mailbox is needed.

**Step 3 — IMAP poller fetches new UIDs.**
`features/inbound/orchestrator/imap/poller.go PollOnce` runs every 2 minutes across all
configured mailboxes. It fetches messages with UIDs above the stored watermark.
Each new message is passed to `InboundProcessor.Process` as a `RawInbound`.

**Step 4 — DetectBounce gates the flow.**
`thread/bounce.go DetectBounce(raw)` applies a two-signal gate:
1. Envelope heuristic: From matches `MAILER-DAEMON|Mail Delivery Subsystem` or
   subject matches `undelivered|returned to sender|delivery failure` etc.
2. Structured body: `Status: X.Y.Z` regex match in body text.
If both signals are present, `BounceInfo.Kind` is set from the first digit of
the status code: `5` → `BounceHard`, `4` → `BounceSoft`. If `Action: delayed`
is present, even a 5.x.x is downgraded to `BounceSoft` (Postfix queuing
artefact).
If no `Status:` line is found, `fallbackDetect` uses subject/body keywords as
a secondary classifier.

**Step 5 — Inbound message recorded.**
`processBounce` calls `recorder.RecordInbound` to persist the DSN itself as an
`outreach_messages` row with `reply_type='bounced'`. This ensures the dashboard
shows a thread history entry for the bounce.

**Step 6 — Original outbound flagged.**
The `In-Reply-To` header from the DSN is matched against `outreach_messages.message_id`.
If found, the outbound row is updated with `bounced_at` + `smtp_response`
(DSNCode + Diagnostic). The `from_address` of the outbound is also captured
here for the mailbox backpressure call in step 9.

**Step 7 — Thread state transition.**
- Hard bounce: `outreach_threads SET status='bounced', next_action='done'` — no
  further sends attempted.
- Soft bounce: `manager.Pause(ctx, threadID, now+3d)` — pauses the sequence
  for 3 days (matches Postfix deferred-queue default lifetime).

**Step 8 — Bounce event logged.**
`EventLogger.LogBounced` inserts a `thread_events` row with `event_type='bounced'`
and increments `outreach_contacts.total_bounced` and `outreach_domains.total_bounced`
counters. These counters drive the intelligence loop's domain-level suppression
thresholds.

**Step 9 — Contact suppressed (hard only).**
`UPDATE outreach_contacts SET status='bounced'` prevents the contact from being
enrolled in future campaign sequences. Soft bounces leave the contact active —
a temporary mailbox-full event does not lose the lead.

**Step 10 — Mailbox backpressure counter (hard only).**
`bounceRecorder.RecordBounce(ctx, fromAddress, "imap_dsn:"+dsnCode)` increments
the per-mailbox consecutive-bounce counter. If the threshold is reached, the
mailbox flips to `bounce_hold` automatically. This was the F3-1 fix: before this
wiring, IMAP-detected DSNs never reached the registry, so the auto-hold
threshold could not trip from real delivery failures.

---

## Hot files

| File | Role |
|------|------|
| `features/inbound/orchestrator/thread/bounce.go` | `DetectBounce` + `fallbackDetect` — RFC 3464 regex parser, BounceInfo struct |
| `features/inbound/orchestrator/thread/inbound.go` | `InboundProcessor.processBounce` — 6-step cascade |
| `features/inbound/orchestrator/imap/poller.go` | IMAP poll loop — fetches messages, calls InboundProcessor |
| `features/outreach/mailboxes/bounce/processor.go` | `Processor.Process` + `ClassifyBounce` — used by campaigns sender path |
| `features/inbound/orchestrator/thread/events.go` | `EventLogger.LogBounced` — bounce counter increments |
| `features/inbound/orchestrator/thread/messages.go` | `MessageRecorder.MarkBounced` (used indirectly via inline UPDATE) |
| `features/outreach/mailboxes/mailbox/backpressure.go` | `Backpressure.RecordBounce` — mailbox auto-hold trigger |

---

## Two bounce paths: IMAP DSN vs. campaigns sender

The codebase has two separate bounce processing paths:

| Path | Entry point | When used |
|------|-------------|-----------|
| **IMAP DSN** | `thread/inbound.go processBounce` | DSN email arrives in mailbox IMAP inbox after delivery |
| **Campaigns sender** | `mailboxes/bounce/processor.go Processor.Process` | Inline SMTP-level bounce signal during active send |

Both paths write to `outreach_contacts.status='bounced'` and feed the mailbox
backpressure counter. The IMAP path additionally writes `thread_events` and
`outreach_messages` (thread history). The campaigns sender path additionally
writes `bounce_events` and `blacklist` (suppression defense-in-depth).

---

## Bypass paths — banned by audit

These patterns are banned because they leave the suppression pipeline
in a corrupted state:

1. **Writing to `bounce_events` without `contact_id`** — orphan rows that no
   intelligence query can attribute. `NOT NULL` constraint enforced at DB level.

2. **UPDATE `contacts.status='bounced'` without prior bounce event** — audit
   gap: operators cannot trace why a contact was suppressed.

3. **Skipping `blacklist` INSERT after hard bounce** — defense-in-depth gap:
   if `contacts.status` is later reset by a migration or operator error,
   `blacklist` provides the second suppression layer.

4. **Calling `ClassifyBounce` or `DetectBounce` and ignoring the result** —
   any caller that runs the classifier but does not persist the result is
   silently dropping bounce signals.

5. **Setting `Action: delayed` in test fixtures for 5.x.x DSNs** — per RFC 3464
   and `DetectBounce` logic, `Action: delayed` downgrades hard→soft regardless
   of status code. Test fixtures must match the intent.

---

## Test fixtures

RFC 3464 compliant `.eml` fixtures for parser validation:

| File | DSN type | Status | Action |
|------|----------|--------|--------|
| `testdata/5xx-permanent-mailbox-not-found.eml` | permanent | 5.1.1 | failed |
| `testdata/4xx-temporary-greylist.eml` | temporary deferral | 4.7.0 | delayed |
| `testdata/4xx-mailbox-full.eml` | temporary | 4.2.2 | delayed |
| `testdata/out-of-office-vacation.eml` | auto-reply (not DSN) | — | — |
| `testdata/blacklist-rejection.eml` | permanent, auth | 5.7.1 | failed |

All fixtures use synthetic addresses only (`@example.com`, `@test.local`,
`@sender.test`). No PII per HARD RULE `feedback_no_pii_in_commands`.

Test file: `features/outreach/mailboxes/bounce/processor_fixtures_test.go`
18 tests covering: RFC 3464 structural integrity, per-fixture `ClassifyBounce`
classification, UTF-8 diagnostics, multi-recipient DSN, 5xx boundary cases,
status code mapping (RFC 5321 / RFC 3463 surface).

---

## SLA

- IMAP poll interval: 2 minutes (configurable via `PollInterval`)
- End-to-end from MTA rejection to `contacts.status='bounced'`: < 5 minutes
  (2 min poll lag + < 1s processor latency)
- Mailbox backpressure auto-hold: fires within same poll cycle as the hard bounce

---

## Related maps

- [`imap-inbound.md`](imap-inbound.md) — full IMAP poller + reply ingestion pipeline
- [`anti-trace.md`](anti-trace.md) — 42-step outbound send pipeline (bounce prevention upstream)
- [`common-libs.md`](common-libs.md) — `audit.MaskEmail` used in bounce log ops
