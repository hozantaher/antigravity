BEGIN;

ALTER TABLE outreach_mailboxes
  ADD COLUMN IF NOT EXISTS pinned_endpoint_label TEXT,
  ADD COLUMN IF NOT EXISTS pinned_endpoint_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pinned_endpoint_by TEXT;

CREATE INDEX IF NOT EXISTS idx_outreach_mailboxes_pinned_endpoint
  ON outreach_mailboxes(pinned_endpoint_label) WHERE pinned_endpoint_label IS NOT NULL;

CREATE TABLE IF NOT EXISTS mailbox_egress_repin_audit (
  id BIGSERIAL PRIMARY KEY,
  mailbox_id BIGINT NOT NULL REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
  old_label TEXT,
  new_label TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_egress_repin_audit_mailbox ON mailbox_egress_repin_audit(mailbox_id, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('074_mailbox_egress_pin') ON CONFLICT DO NOTHING;

COMMIT;
