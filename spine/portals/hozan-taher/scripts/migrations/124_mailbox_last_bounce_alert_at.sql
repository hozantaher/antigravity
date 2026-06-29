-- 124_mailbox_last_bounce_alert_at.sql
--
-- AV-F8 (2026-05-19): bounce anomaly detection + auto-pause.
--
-- Adds two columns to outreach_mailboxes:
--   paused_until           TIMESTAMPTZ  — auto-resume target (operator can override
--                                         by manually flipping status back to 'active').
--   last_bounce_alert_at   TIMESTAMPTZ  — cooldown stamp; the AV-F8 cron will not
--                                         re-emit a bounce_anomaly alert / re-pause
--                                         within COOLDOWN_HOURS (12h) of this value.
--
-- Schema verified 2026-05-19 via `\d outreach_mailboxes` (neither column exists):
--   id, address, status, status_reason, consecutive_bounces, total_bounced, total_sent, ...
--   no paused_until, no last_bounce_alert_at
--
-- Per feedback_schema_verify_before_sql T0.
--
-- Predecessor: 123_reply_classifications_log.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '123_reply_classifications_log'
  ) THEN
    RAISE EXCEPTION 'Predecessor 123_reply_classifications_log not applied';
  END IF;
END $$;

BEGIN;

ALTER TABLE outreach_mailboxes
  ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_bounce_alert_at TIMESTAMPTZ;

COMMENT ON COLUMN outreach_mailboxes.paused_until IS
  'AV-F8: auto-pause expiry. Set by runBounceAnomalyCron when bounce rate crosses threshold. Operator may manually flip status back to active early; cron does NOT auto-resume.';

COMMENT ON COLUMN outreach_mailboxes.last_bounce_alert_at IS
  'AV-F8: cooldown stamp — bounce_anomaly cron will not re-pause / re-alert within 12h of this value (idempotency window).';

INSERT INTO schema_migrations (version)
  VALUES ('124_mailbox_last_bounce_alert_at')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification (feedback_verify_select_after_migration T0):
\echo '── Columns added: ──'
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'outreach_mailboxes'
   AND column_name IN ('paused_until', 'last_bounce_alert_at')
 ORDER BY column_name;

\echo '── Migration recorded: ──'
SELECT version FROM schema_migrations WHERE version = '124_mailbox_last_bounce_alert_at';

-- Audit log mutation (feedback_audit_log_on_mutations T0).
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'schema_migration_applied',
  'migration',
  'schema_migrations',
  '124',
  jsonb_build_object(
    'migration', '124_mailbox_last_bounce_alert_at.sql',
    'reason', 'AV-F8: bounce anomaly auto-pause needs paused_until + last_bounce_alert_at columns on outreach_mailboxes.'
  )
);
