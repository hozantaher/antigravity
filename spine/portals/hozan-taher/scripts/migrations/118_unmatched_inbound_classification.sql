-- 118_unmatched_inbound_classification.sql
--
-- AJ-bounce (2026-05-18): auto-classify Mailer-Daemon bounces in
-- unmatched_inbound and let the BFF default-filter them out of the
-- operator /replies view.
--
-- Background: the 2026-05-18 IMAP backfill (after the 5-day silent
-- ingestion outage fixed in 117) ingested 144 rows into
-- unmatched_inbound. ~118 are Mailer-Daemon DSN bounces whose
-- Final-Recipient could not be extracted, so processUnmatchedBounce
-- fell through to parkUnattributed instead of being routed via the
-- bounce path. Only ~26 are real customer replies. Without filtering,
-- the operator's /replies (Nezpárované) view is 80%% noise.
--
-- Design (matches PR spec):
--   1. Add `classification` TEXT column to unmatched_inbound.
--      NULL = unclassified (default), 'bounce' = DSN bounce,
--      'auto_reply' = out-of-office / vacation auto-reply.
--   2. Backfill the existing rows using the same regex patterns the
--      Go orchestrator now applies on INSERT (services/orchestrator/
--      thread/inbound.go: classifyUnmatched).
--   3. Index for filter performance (partial — only classified rows).
--   4. operator_audit_log row records the bulk backfill so the
--      mutation is traceable (feedback_audit_log_on_mutations T0).
--
-- Predecessor: 117_notify_reply_trigger_jsonb_safe.sql
--
-- Idempotent: re-running this migration has no effect — IF NOT EXISTS
-- guards the column + index, and the UPDATE is bounded by the same
-- predicates so already-classified rows are not re-touched (the second
-- run sees 0 affected rows). The audit_log INSERT is unconditional so
-- a re-run is visible but never destructive.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '117_notify_reply_trigger_jsonb_safe'
  ) THEN
    RAISE EXCEPTION 'Predecessor 117_notify_reply_trigger_jsonb_safe not applied';
  END IF;
END $$;

BEGIN;

-- 1. Column.
ALTER TABLE unmatched_inbound
  ADD COLUMN IF NOT EXISTS classification TEXT;

COMMENT ON COLUMN unmatched_inbound.classification IS
  'AJ-bounce (2026-05-18): auto-set by orchestrator on INSERT. NULL = unclassified real reply, ''bounce'' = DSN/mailer-daemon, ''auto_reply'' = out-of-office.';

-- 2. Backfill — match the Go-side regex (classifyUnmatched).
-- Bounce signal: from_address matches mailer-daemon/postmaster/mail
-- delivery system, OR subject matches the canonical DSN subject hints.
-- Same patterns as services/orchestrator/thread/inbound.go regex
-- constants so the DB-side and code-side stay in lockstep.
WITH backfilled AS (
  UPDATE unmatched_inbound
     SET classification = 'bounce'
   WHERE classification IS NULL
     AND (
       from_address ~* '(mailer-daemon|postmaster|mail[[:space:]-]*delivery[[:space:]-]*(subsystem|system|service))'
       OR subject ~* '(undeliverable|undelivered|nedoručitelná|returned[[:space:]]+to[[:space:]]+sender|delivery[[:space:]]+(status|failure|notification|problem)|mail[[:space:]]+delivery[[:space:]]+(system|fail)|could[[:space:]]+not[[:space:]]+be[[:space:]]+delivered|rejected:)'
     )
   RETURNING id
)
SELECT count(*) AS bounces_backfilled FROM backfilled \gset

WITH auto_replied AS (
  UPDATE unmatched_inbound
     SET classification = 'auto_reply'
   WHERE classification IS NULL
     AND subject ~* '(automatick[áa][[:space:]]+odpov[ěe]ď|out[[:space:]]+of[[:space:]]+office|i[[:space:]]+am[[:space:]]+out[[:space:]]+of|absence|am[[:space:]]+abwesend|automatic[[:space:]]+reply)'
   RETURNING id
)
SELECT count(*) AS auto_replies_backfilled FROM auto_replied \gset

-- 3. Index — partial, only classified rows. Operator default-filter
-- query is `WHERE classification IS NULL OR classification != 'bounce'`
-- which is satisfied by a seq scan in the common (small) case, but the
-- index helps the explicit `?include_bounces=false` count query that
-- enumerates by classification.
CREATE INDEX IF NOT EXISTS idx_unmatched_inbound_classification
  ON unmatched_inbound(classification)
  WHERE classification IS NOT NULL;

-- 4. Audit log. feedback_audit_log_on_mutations T0 — bulk UPDATE
-- changing operator-visible state must emit an entry.
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'unmatched_inbound_classification_backfill',
  'migration',
  'unmatched_inbound',
  'bulk',
  jsonb_build_object(
    'migration',         '118_unmatched_inbound_classification.sql',
    'bounces_backfilled', :'bounces_backfilled',
    'auto_replies_backfilled', :'auto_replies_backfilled',
    'reason',            'AJ-bounce: hide DSN noise from default /replies operator view',
    'reversible',        true
  )
);

-- 5. Record migration.
INSERT INTO schema_migrations (version)
  VALUES ('118_unmatched_inbound_classification')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification queries (feedback_verify_select_after_migration T0):
\echo '── Schema verification:'
\d unmatched_inbound

\echo '── Classification distribution:'
SELECT classification, count(*) AS rows
  FROM unmatched_inbound
 GROUP BY classification
 ORDER BY classification NULLS FIRST;

\echo '── Sample of newly-classified bounces (first 5):'
SELECT id, classification, LEFT(from_address, 60) AS from_address, LEFT(subject, 80) AS subject
  FROM unmatched_inbound
 WHERE classification = 'bounce'
 ORDER BY received_at DESC
 LIMIT 5;
