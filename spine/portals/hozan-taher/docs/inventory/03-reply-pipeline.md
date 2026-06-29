# Inventory: Reply Pipeline + IMAP

## 1. IMAP Poller (features/inbound/orchestrator/imap/)

- `poller.go:21–37` — `Poller` struct + `NewPoller()`; in-memory dedup via `seen` map keyed on Message-ID
- `poller.go:54–105` — `PollOnce()`: single cycle across all mailboxes; per-mailbox fetch/match/error/duration logging
- `poller.go:151–177` — `PollDaemon()`: long-running goroutine, configurable interval, NOOP heartbeats every 20 min
- `poller.go:229–243` — fetches `UNSEEN` since `lastPoll`; falls back to `uid:<uid>@<host>` Message-ID if missing
- `poller.go:111–143` — `runWithReconnect()`: exponential backoff (1s → 5min cap)
- `poller.go:271–298` — `connect()`: TLS for port 993, plain TCP otherwise; 10s dial / 5s read timeout
- `poller.go:300–322` — `command()`: LOGIN/SELECT/NOOP with tagged response handling (A001+, NO/BAD detect)
- `poller.go:362–398` — `fetchMessage()`: BODY[HEADER.FIELDS …] + BODY[TEXT]; tail-scan completion to avoid O(n²)
- `poller.go:400–452` — `parseFetchResponse()`: literal markers `{N}\r\n` + double-CRLF fallback; net/mail or regex header parse
- Bootstrap: orchestrator main.go wires PollDaemon with panic-recovered goroutine

## 2. Inbound Processing (features/inbound/orchestrator/thread/)

### Thread matching
- `inbound.go:68–178` — `ProcessReply()` main entrypoint
- `inbound.go:275–315` — `matchToThread()`: In-Reply-To first, then References list; cleans `<>` and whitespace

### Bounce detection (PRE-classification gate — critical to avoid DSN misclassification)
- `inbound.go:80–87` — `DetectBounce()` runs FIRST
- `bounce.go:79–112` — envelope check (From, Subject, X-Failed-Recipients) + RFC 3464 `Status: X.Y.Z`; first digit = hard/soft; `Action: delayed` downgrades 5.x.x → soft
- `bounce.go:135–151` — `fallbackDetect()` for plain-text NDRs without Status (subject/body keywords)

### Per-ReplyType actions
- `inbound.go:122–175` — switch:
  - `ReplyNegative` → close thread + INSERT outreach_suppressions reason='negative_reply'
  - `ReplyAutoOOO` → pause 14 days
  - `ReplyLater` → pause 30 days
  - `ReplyMeeting` / `ReplyInterested` → mark replied + `onInterested` hook + upsert lead
  - `ReplyObjection` → mark replied (sequence continues)

### Lead upsert (sales funnel)
- `inbound.go:387–423` — `upsertLead()`: INSERT leads (status='new', source='reply_classifier'); UNIQUE (contact_id, campaign_id) ON CONFLICT UPDATE

### Bounce processing path
- `inbound.go:189–273` — `processBounce()`: records DSN, updates outbound bounced_at + smtp_response, transitions thread (hard → 'bounced'+done; soft → pause 3d), increments contact + domain counters; hard bounce flips contacts.status='bounced'

## 3. Reply Classification

### Keyword baseline (Go)
- `features/platform/common/humanize/response.go:20–27` — ReplyType enum (Interested, Meeting, Later, Objection, Negative, AutoOOO)
- `response.go:70–115` — `ClassifyReply()`: priority OOO > Negative > Meeting > Interested > Later
- Czech keywords: `nemáme zájem`, `nechci`, `odhlásit` (negative); `zájem`, `pošlete` (interested); `zavolej`, `schůzka` (meeting); `později`, `teď ne` (later); `mimo kancelář`, `dovolená` (ooo)

### LLM semantic fallback
- `features/platform/outreach-dashboard/src/lib/llmReplyClassifier.js:1–42` — `semanticClassifyReply()`: Ollama default, configurable via `LLM_PROVIDER`
- `:36–42` — `VALID_LABELS` whitelist (positive/negative/auto_reply/question/unknown) blocks LLM hallucinations
- `:86–129` — confidence < 0.6 → fall back to regex (deterministic)
- `:148–186` — `classifyViaOllama()`: `/api/generate` JSON format, temp 0, max 200 tokens, 5s timeout; resilient parse (strips markdown fences)

### JS regex mirror
- `features/platform/outreach-dashboard/src/lib/replyClassifier.js` — mirrors Go logic; OOO_RE, NEGATIVE_RE, INTERESTED_RE; returns `ooo|negative|interested|question|unknown`

### Sentiment + serialization
- `inbound.go:324–337` — `classifySentiment()`: ReplyType → Sentiment enum (positive/neutral/negative/ooo)
- `inbound.go:359–376` — `replyTypeString()`: enum → DB string (`interested`, `meeting`, `later`, `objection`, `negative`, `ooo`, `unknown`)

## 4. Suppression Cascade

- `inbound.go:133–140` — ReplyNegative → INSERT outreach_suppressions ON CONFLICT DO NOTHING (idempotent)
- `inbound.go:256–263` — hard bounce → contacts.status='bounced'
- `scripts/migrations/005_contacts_status_sync.sql` — AFTER INSERT trigger mirrors outreach_suppressions → contacts.status='suppressed' (case-insensitive email)
- Pre-send filter via UNION (features/outreach/campaigns/campaign/runner.go) excludes suppressed contacts

## 5. Audit Trail (features/inbound/orchestrator/thread/events.go)

- EventType enum (line 12–25): Sent, Delivered, Opened, Clicked, Replied, Bounced, Complained, Suppressed, ScoreChanged
- `Log()` (49–72) — generic insert with metadata JSON
- `LogReplied()` (104–117) — increments contact.total_replied, updates last_replied
- `LogBounced()` (119–147) — increments contact + domain bounce counters; non-fatal failures logged
- `messages.go:90–107+` — `RecordInbound()` stores body_preview (200 char), body_hash, sentiment, reply_type

## 6. Operator UI for Replies

- `reply_inbox` table — send_event_id, campaign_id, contact_id, mailbox_id, from_email, subject, classification, received_at, handled, handled_at
- `features/inbound/inbox/web/threads.go:21–77` — `HandleReplyDetail()` POST `/api/replies/{id}/reply` with `{body}`; INSERT manual_reply_outbox; mark reply_inbox.handled=true
- `features/platform/outreach-dashboard/src/pages/ThreadDetail.jsx` — React component for thread view + classification history
- `useOutreachHealth` Zustand store — banner on IMAP daemon failures

## 7. Test / Simulation (mailsim)

- `features/inbound/orchestrator/mailsim/reply.go:31–67` — `ReplyBuilder.Build()`: synthetic RFC 822 reply per behavior; OOO tagged Auto-Submitted: auto-replied per RFC 3834
- `features/inbound/orchestrator/mailsim/bouncer.go` — RFC 3464 DSN generator (Status, Diagnostic-Code, Final-Recipient, Action)
- Behaviors: ReplyInterested/Negative/OOO/Later/Meeting + BounceHard/Soft

## 8. Health Surfaces

- `poller.go:101–103` — `health.Report("imap_poll", true, "")` after each cycle
- `features/inbound/orchestrator/protections/probe/probes_l3_state.go` — circuit_opened_at + trip_count on outreach_domains
- `/health` daemon block surfaces IMAP poll status

## 9. Key Tables (schema)

- **outreach_threads** — id, contact_id, campaign_id, status, current_step, next_action, next_action_at, pause_until
- **outreach_messages** — id, thread_id, direction, message_id, in_reply_to, references_header, sentiment, reply_type, sent_at, delivered_at, opened_at, clicked_at, replied_at, bounced_at, mailbox_used, smtp_response, humanize_applied
- **outreach_events** — id, contact_id, thread_id, message_id, event_type, metadata JSON, created_at
- **outreach_suppressions** — email UNIQUE, reason, created_at
- **leads** — id, contact_id, campaign_id, status, source, sentiment, original_message_id, UNIQUE (contact_id, campaign_id)
- **reply_inbox** — send_event_id UNIQUE FK, classification, received_at, handled

## TL;DR Flow

```
IMAP poll → InboundProcessor.ProcessReply
              ├─ DetectBounce() → if bounce → processBounce() (DSN path)
              └─ ClassifyReply() (humanize → optional LLM @ confidence>0.6)
                  └─ switch ReplyType
                       ├─ Negative   → suppress + close
                       ├─ OOO/Later  → pause N days
                       ├─ Meeting/Interested → mark + lead upsert + hook
                       └─ Objection  → mark replied (continue)
                  └─ Log event + update contact counters + audit
```
