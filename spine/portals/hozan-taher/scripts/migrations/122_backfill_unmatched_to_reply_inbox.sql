-- 122_backfill_unmatched_to_reply_inbox.sql
--
-- AV-F1 (2026-05-19): backfill the 47 historical real-customer replies
-- from unmatched_inbound → reply_inbox now that the orchestrator's
-- Schema-A fallback (inbound.go::matchToReplyInbox) is wired.
--
-- Root cause: matchToThread joins outreach_threads + outreach_contacts
-- (Schema B), both empty in current deployment. Every reply produced
-- threadID=0 even when send_events + contacts held a perfectly good
-- (campaign, contact, mailbox) chain. The new matchToReplyInbox bridge
-- walks Schema A directly. This migration backfills the historical
-- orphans by performing the same lookup in SQL.
--
-- Eligibility:
--   - unmatched_inbound row with classification IS NULL (real customer
--     reply, not bounce / corrupted / auto-reply)
--   - from_address NOT system (postmaster / mailer-daemon / noreply)
--   - bare email matches contacts.email (case-insensitive)
--
-- For each eligible orphan:
--   1. Look up contact_id via LOWER(email)
--   2. Look up most recent send_events row for that contact
--   3. INSERT into reply_inbox (handled=FALSE so it lands in operator view)
--   4. UPDATE unmatched_inbound.classification='migrated_to_reply_inbox'
--      so the AS-F1 UNION ALL doesn't duplicate the row in /replies
--
-- Predecessor: 121_vehicles_inventory.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '121_vehicles_inventory'
  ) THEN
    RAISE EXCEPTION 'Predecessor 121_vehicles_inventory not applied';
  END IF;
END $$;

BEGIN;

-- Materialize the candidate set first so we can audit + count.
CREATE TEMP TABLE av_f1_backfill_candidates AS
WITH bare AS (
  SELECT u.id AS unmatched_id,
         u.message_id,
         u.subject,
         u.received_at,
         LOWER(
           COALESCE(
             NULLIF(TRIM(SUBSTRING(u.from_address FROM '<([^>]+)>')), ''),
             TRIM(u.from_address)
           )
         ) AS bare_email
    FROM unmatched_inbound u
   WHERE u.classification IS NULL
     AND u.from_address IS NOT NULL
     AND u.from_address <> ''
     AND LOWER(u.from_address) NOT LIKE '%postmaster%'
     AND LOWER(u.from_address) NOT LIKE '%mailer-daemon%'
     AND LOWER(u.from_address) NOT LIKE '%noreply%'
     AND LOWER(u.from_address) NOT LIKE '%no-reply%'
),
resolved AS (
  SELECT b.unmatched_id, b.message_id, b.subject, b.received_at, b.bare_email,
         ct.id AS contact_id,
         se.id AS send_event_id,
         se.campaign_id,
         (SELECT m.id FROM outreach_mailboxes m
           WHERE m.from_address = se.mailbox_used LIMIT 1) AS mailbox_id
    FROM bare b
    JOIN contacts ct ON LOWER(ct.email) = b.bare_email
                    AND ct.email IS NOT NULL
                    AND ct.email <> ''
    LEFT JOIN LATERAL (
      SELECT se.id, se.campaign_id, se.mailbox_used, se.sent_at
        FROM send_events se
       WHERE se.contact_id = ct.id
       ORDER BY se.sent_at DESC NULLS LAST
       LIMIT 1
    ) se ON TRUE
)
SELECT * FROM resolved;

\echo '── Candidates resolved: ──'
SELECT count(*) AS resolved_candidates,
       count(send_event_id) AS with_send_event,
       count(mailbox_id) AS with_mailbox
  FROM av_f1_backfill_candidates;

-- INSERT into reply_inbox (one row per resolved orphan).
WITH inserted AS (
  INSERT INTO reply_inbox (
    campaign_id, contact_id, mailbox_id, send_event_id,
    from_email, subject, received_at, handled
  )
  SELECT c.campaign_id, c.contact_id, c.mailbox_id, c.send_event_id,
         c.bare_email,
         COALESCE(c.subject, '(bez předmětu)'),
         c.received_at,
         FALSE
    FROM av_f1_backfill_candidates c
  RETURNING id
)
SELECT count(*) AS rows_inserted FROM inserted \gset

\echo '── rows_inserted into reply_inbox: ──'
SELECT :'rows_inserted' AS rows_inserted;

-- Mark the unmatched_inbound rows so they disappear from the operator's
-- default view (BFF UNION already excludes classification='bounce' /
-- 'corrupted_charset'; we add 'migrated_to_reply_inbox' to that exclusion
-- in a follow-up BFF tweak — for now the row stays visible but classified).
UPDATE unmatched_inbound
   SET classification = 'migrated_to_reply_inbox'
 WHERE id IN (SELECT unmatched_id FROM av_f1_backfill_candidates);

INSERT INTO schema_migrations (version)
  VALUES ('122_backfill_unmatched_to_reply_inbox')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification queries (feedback_verify_select_after_migration T0):
\echo '── reply_inbox count: ──'
SELECT count(*) AS reply_inbox_total FROM reply_inbox;

\echo '── unmatched_inbound real-customer remaining: ──'
SELECT count(*) AS still_unmatched_real
  FROM unmatched_inbound
 WHERE classification IS NULL
   AND from_address IS NOT NULL
   AND from_address <> ''
   AND LOWER(from_address) NOT LIKE '%postmaster%'
   AND LOWER(from_address) NOT LIKE '%mailer-daemon%'
   AND LOWER(from_address) NOT LIKE '%noreply%';

\echo '── Sample of inserted reply_inbox rows: ──'
SELECT r.id, r.from_email, LEFT(r.subject, 40) AS subject,
       r.campaign_id, r.contact_id, r.mailbox_id, r.send_event_id
  FROM reply_inbox r
 ORDER BY r.id DESC
 LIMIT 5;

\echo '── Audit log mutation (feedback_audit_log_on_mutations T0): ──'
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'schema_migration_applied',
  'migration',
  'schema_migrations',
  '122',
  jsonb_build_object(
    'migration', '122_backfill_unmatched_to_reply_inbox.sql',
    'rows_backfilled', (SELECT count(*) FROM reply_inbox)::int,
    'reason', 'AV-F1: bridge unmatched_inbound → reply_inbox for real customer replies; matchToReplyInbox lookup wired in orchestrator.'
  )
);

\echo '── Migration recorded: ──'
SELECT version FROM schema_migrations WHERE version = '122_backfill_unmatched_to_reply_inbox';
