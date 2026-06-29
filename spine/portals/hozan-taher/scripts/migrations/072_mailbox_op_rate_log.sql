BEGIN;

CREATE TABLE IF NOT EXISTS mailbox_op_rate_log (
  id           BIGSERIAL PRIMARY KEY,
  mailbox_id   BIGINT NOT NULL REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
  op_type      TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata     JSONB
);

ALTER TABLE mailbox_op_rate_log
  DROP CONSTRAINT IF EXISTS mailbox_op_rate_log_op_type_check;
ALTER TABLE mailbox_op_rate_log
  ADD CONSTRAINT mailbox_op_rate_log_op_type_check CHECK (
    op_type IN ('imap_poll', 'imap_inbox_fetch', 'full_check', 'smtp_probe', 'send', 'verify_email')
  );

-- Hot index for rate limit query: WHERE mailbox_id=$1 AND op_type=$2 AND occurred_at > now() - interval '1 hour'
CREATE INDEX IF NOT EXISTS idx_mailbox_op_rate_log_lookup
  ON mailbox_op_rate_log (mailbox_id, op_type, occurred_at DESC);

-- Cleanup index for daily cron
CREATE INDEX IF NOT EXISTS idx_mailbox_op_rate_log_cleanup
  ON mailbox_op_rate_log (occurred_at);

INSERT INTO schema_migrations (version) VALUES ('072_mailbox_op_rate_log') ON CONFLICT DO NOTHING;
COMMIT;
