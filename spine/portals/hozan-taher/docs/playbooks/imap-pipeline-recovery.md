# IMAP ingest pipeline — diagnostic + recovery runbook

**Last updated:** 2026-05-18 (after 5-day silent-ingest incident)

## When to use this playbook

Symptoms that route here:
- `/replies` shows few or zero new entries despite ongoing campaign
- Operator sees real customer reply in webmail INBOX but not in dashboard
- `unmatched_inbound` count flat for ≥24h while campaign is sending
- `mailbox_alerts` row with `type='imap_inbox_gap'` (emitted by hourly audit cron)

## Mental model

Inbound flow (post-2026-05-18 hardening):

```
Seznam IMAP INBOX
   ↓ (Go runner machinery-outreach, every 2 min via UID watermark)
imap.Poller.fetchNewMessagesWithWatermark
   ↓
thread.ProcessReply
   ├── isTestMessage(subject)  → discard ([smoke], [test], probe …)
   ├── isInternalSender(from)  → discard (hozan.taher.XX@post.cz)
   ├── matchToThread → thread_id == 0 (typical for B2B replies)
   │    ├── hard bounce → processUnmatchedBounce (7-pattern extractor) → flip contact.email_status
   │    │     └── recipient unextractable → fall through ↓
   │    └── parkUnattributed
   │           ├── safeUTF8 sanitize all TEXT
   │           ├── classifyUnmatched → 'bounce' / 'auto_reply' / NULL
   │           └── INSERT unmatched_inbound (trigger notify_reply_inserted fires)
   └── matched thread_id > 0  → processBounce or RecordInbound → reply_inbox
```

Dashboard `/replies` reads `unmatched_inbound` (+ `reply_inbox` for matched).
Default filter: `classification IS NULL OR classification != 'bounce'` (operator sees real leads, bounces in "Bounces" tab).

## Diagnostic queries (read-only, safe)

```sql
-- 1. Watermark state per mailbox
SELECT mb.email, s.uid_validity, s.last_processed_uid, s.polled_at,
       age(NOW(), s.polled_at) AS since_last_poll
FROM mailbox_imap_state s
JOIN outreach_mailboxes mb ON mb.id = s.mailbox_id
ORDER BY mb.email;

-- 2. Ingestion volume by classification (last 24h)
SELECT classification, count(*) FROM unmatched_inbound
WHERE received_at > NOW() - INTERVAL '24 hours'
GROUP BY classification ORDER BY count(*) DESC;

-- 3. Recent contact email_status flips (bounce_hold from IMAP)
SELECT count(*) AS recent_bounces FROM contacts
WHERE email_status='bounce_hold' AND updated_at > NOW() - INTERVAL '24 hours';

-- 4. Trigger function check (must use to_jsonb pattern post-117)
SELECT pg_get_functiondef(p.oid) FROM pg_proc p
WHERE p.proname = 'notify_reply_inserted';

-- 5. Sequence-vs-max gap (high gap = ON CONFLICT churn from repeated re-processing)
SELECT 'seq' AS metric, last_value::text FROM unmatched_inbound_id_seq
UNION ALL SELECT 'max_id', max(id)::text FROM unmatched_inbound;
```

## Live INBOX inspection via relay

If polling state looks fine but real customer leads still missing, query the actual IMAP INBOX:

```bash
DSN="postgresql://outreach:outreach_053ff0c20c74809c@junction.proxy.rlwy.net:54755/outreach"
MB_EMAIL=$(psql "$DSN" -tAc "SELECT email FROM outreach_mailboxes WHERE id=1182;")
MB_PASS=$(psql "$DSN" -tAc "SELECT password FROM outreach_mailboxes WHERE id=1182;")
TOKEN=$(grep '^ANTI_TRACE_RELAY_TOKEN=' features/platform/outreach-dashboard/.env | cut -d= -f2-)

curl -s -X POST "https://anti-trace-relay-production-a706.up.railway.app/v1/imap-fetch" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"mailbox_address\":\"$MB_EMAIL\",\"imap_host\":\"imap.post.cz\",\"imap_port\":993,\"username\":\"$MB_EMAIL\",\"password\":\"$MB_PASS\",\"folder\":\"INBOX\",\"limit\":50,\"since_uid\":0,\"preferred_country\":\"CZ\"}" \
  | jq '{unseen_total, uid_validity, messages: .messages | length, max_uid: ([.messages[].uid] | max)}'
```

Returns `unseen_total` (total UNSEEN in INBOX) + max UID. Compare to `mailbox_imap_state.last_processed_uid`.

If `unseen_total > 0` and most UIDs < watermark → operator is reading webmail (marks \Seen) before poller catches them. This is the **2026-05-13 incident pattern**. Recovery:

## Recovery: watermark backfill

When operator has unseen mail in INBOX with UIDs ≤ watermark:

```sql
-- Reset watermark for one mailbox (or all 4 with email LIKE 'hozan.taher.%')
UPDATE mailbox_imap_state SET last_processed_uid = 0
WHERE mailbox_id IN (
  SELECT id FROM outreach_mailboxes WHERE email LIKE 'hozan.taher.%@post.cz'
);

-- Audit log
INSERT INTO operator_audit_log (action, actor, entity_type, details)
VALUES ('imap_watermark_backfill', 'operator', 'mailbox_pool',
  jsonb_build_object('reason', 'YOUR-INCIDENT-REASON', 'incident_date', 'YYYY-MM-DD'));
```

Wait 2-3 minutes. Go runner's next poll re-fetches all UIDs > 0 (via PR #1429 UID watermark search). Verify:

```sql
SELECT count(*) FROM unmatched_inbound WHERE received_at > NOW() - INTERVAL '5 minutes';
```

Should grow within 5 min.

**Side effects of backfill:**
- Same MessageIDs re-processed → ON CONFLICT DO UPDATE (sequence advances but no new rows for already-ingested)
- 116-pattern bounces (post-2026-05-18 hardening) flip contact email_status via extractBouncedRecipient
- Real customer replies land in unmatched_inbound with classification IS NULL
- Internal mb-to-mb sender pings discarded silently (PR #1434 filter)
- `[smoke]`, `[test]`, etc. discarded silently

## If trigger function fails (pq:42703 class)

Symptom: `parkUnattributed failed: pq: record "new" has no field "X" (42703)` in BFF logs.

Cause: someone modified the trigger function to reference a column that doesn't exist on one of its attached tables (`reply_inbox` vs `unmatched_inbound`).

Recovery: re-apply migration 117 (idempotent CREATE OR REPLACE) and verify ratchet:

```sql
\i scripts/migrations/117_notify_reply_trigger_jsonb_safe.sql
```

Or run the audit test:

```bash
DATABASE_URL="<dsn>" pnpm exec vitest run tests/audit/notify_reply_trigger_safe.test.js tests/audit/trigger_functions_column_safe.test.js
```

## If INBOX is empty but watermark advanced

Sparse UIDs (server-assigned to Drafts/Sent/expunged messages count toward UID counter but not INBOX). Normal Seznam behavior. Not a bug — watermark just tracks "max UID we've seen", not "count of messages".

Confirm via the live INBOX inspection above.

## Monitoring / alarms

- **mailbox_alerts type='imap_inbox_gap'**: hourly audit cron (PR #1439) detects > 10 unseen messages vs <24h ingested count per mailbox
- **mailbox_alerts type='auth_locked'**: 3 consecutive IMAP auth fails (PR AP6)
- **operator_audit_log action='imap_watermark_backfill'**: history of manual backfills

## Past incidents (post-mortems)

- **2026-05-13 → 2026-05-18 silent ingest outage**: pre-fix poller used `UID SEARCH UNSEEN`, skipped messages operator read in webmail. Trigger had `NEW.from_email` direct ref → 42703 on every unmatched INSERT. 26 customer leads stuck for 5 days.
  - Root-cause fixes: PR #1429 (UID watermark), PR #1435 (trigger jsonb-safe + migration 117).
  - Ratchets added: PR #1436 (all-trigger-functions audit), `notify_reply_trigger_safe.test.js`.
  - Lessons: triggers fire on multiple tables; column drift invisible to sqlmock-based tests.

## Audit ratchets (CI gates)

- `tests/audit/notify_reply_trigger_safe.test.js` — verify notify_reply_inserted uses to_jsonb pattern
- `tests/audit/trigger_functions_column_safe.test.js` — generic for all trigger fns
- `tests/audit/sql_query_drift.test.js` — PREPAREs every SELECT in BFF code
- `tests/audit/ar6-cron-jitter.test.js` — new IMAP audit cron registered
- `features/inbound/orchestrator/thread/integration_full_pipeline_test.go` — Go E2E walk-through (TBD per PR after this runbook)
