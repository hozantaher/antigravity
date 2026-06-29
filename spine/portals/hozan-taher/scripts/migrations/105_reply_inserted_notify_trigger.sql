-- migration 105: NOTIFY triggers for real-time SSE on /replies
-- Predecessor: 104_campaign_pacing_overrides.sql
-- Purpose: Emit pg_notify('reply_inserted', <json>) on INSERT into
--   reply_inbox and unmatched_inbound so the BFF SSE endpoint can
--   fan out to connected Replies.jsx clients (Sprint F1 / issue #1265).
-- Notes:
--   - 'from' field is stripped at BFF fan-out (feedback_no_pii_in_commands);
--     but we also omit it here to keep the payload minimal.
--   - reply_inbox uses from_email; unmatched_inbound uses from_address.
--     COALESCE handles both without schema changes.
--   - trigger name follows naming convention <table>_notify.

CREATE OR REPLACE FUNCTION notify_reply_inserted() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'reply_inserted',
    json_build_object(
      'source',      TG_TABLE_NAME,
      'id',          NEW.id,
      'received_at', COALESCE(NEW.received_at, now())::text
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reply_inbox_notify ON reply_inbox;
CREATE TRIGGER reply_inbox_notify
  AFTER INSERT ON reply_inbox
  FOR EACH ROW EXECUTE FUNCTION notify_reply_inserted();

DROP TRIGGER IF EXISTS unmatched_inbound_notify ON unmatched_inbound;
CREATE TRIGGER unmatched_inbound_notify
  AFTER INSERT ON unmatched_inbound
  FOR EACH ROW EXECUTE FUNCTION notify_reply_inserted();
