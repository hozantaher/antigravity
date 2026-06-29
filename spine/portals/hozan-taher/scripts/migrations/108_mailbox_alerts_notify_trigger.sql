-- migration 108: pg_notify trigger for mailbox_alerts real-time SSE (Sprint M7)
-- Predecessor: 107_campaign_send_window.sql
-- Purpose: Emit pg_notify('mailbox_alert_fired', <json>) on INSERT into
--   mailbox_alerts so the BFF SSE endpoint /api/alerts/stream can push
--   deliverability alert toasts to connected operator sessions.
--
-- PII policy (feedback_no_pii_in_commands):
--   Payload carries NO full email address. from_address is fetched at
--   BFF fan-out and redacted to "xxxx@domain" form. Trigger payload
--   carries only structural metadata: id, mailbox_id, type, severity,
--   created_at. The BFF joins from_address and redacts before emitting
--   to the SSE stream.
--
-- Trigger naming convention: <table>_notify (matches 105_reply_inserted).

CREATE OR REPLACE FUNCTION notify_mailbox_alert_fired() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'mailbox_alert_fired',
    json_build_object(
      'id',          NEW.id,
      'mailbox_id',  NEW.mailbox_id,
      'type',        COALESCE(NEW.type, 'unknown'),
      'severity',    COALESCE(NEW.severity, 'warning'),
      'message',     COALESCE(NEW.message, ''),
      'created_at',  COALESCE(NEW.created_at, now())::text
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mailbox_alerts_notify ON mailbox_alerts;
CREATE TRIGGER mailbox_alerts_notify
  AFTER INSERT ON mailbox_alerts
  FOR EACH ROW EXECUTE FUNCTION notify_mailbox_alert_fired();

-- schema_migrations record (predecessor check: 107 must exist).
INSERT INTO schema_migrations (filename, applied_at)
VALUES ('108_mailbox_alerts_notify_trigger.sql', now())
ON CONFLICT (filename) DO NOTHING;
