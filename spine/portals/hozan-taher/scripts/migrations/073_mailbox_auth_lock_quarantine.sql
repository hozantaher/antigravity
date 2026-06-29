BEGIN;

-- Extend status enum to include auth_locked
ALTER TABLE outreach_mailboxes DROP CONSTRAINT IF EXISTS outreach_mailboxes_status_check;
ALTER TABLE outreach_mailboxes
  ADD CONSTRAINT outreach_mailboxes_status_check CHECK (
    status IN ('active', 'paused', 'bounce_hold', 'retired', 'auth_locked', 'egress_chaos_detected')
  );

-- Add quarantine timestamp + reason
ALTER TABLE outreach_mailboxes
  ADD COLUMN IF NOT EXISTS auth_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auth_locked_reason TEXT,
  ADD COLUMN IF NOT EXISTS auth_locked_by_observer TEXT;

-- mailbox_auth_fails table — may already exist with older schema; add missing columns
CREATE TABLE IF NOT EXISTS mailbox_auth_fails (
  id          BIGSERIAL PRIMARY KEY,
  mailbox_id  BIGINT NOT NULL REFERENCES outreach_mailboxes(id) ON DELETE CASCADE,
  op_type     TEXT NOT NULL DEFAULT 'smtp_probe',
  error_msg   TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observer    TEXT
);

-- Add columns that may be missing in pre-existing mailbox_auth_fails table
ALTER TABLE mailbox_auth_fails ADD COLUMN IF NOT EXISTS op_type TEXT NOT NULL DEFAULT 'smtp_probe';
ALTER TABLE mailbox_auth_fails ADD COLUMN IF NOT EXISTS error_msg TEXT;
ALTER TABLE mailbox_auth_fails ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE mailbox_auth_fails ADD COLUMN IF NOT EXISTS observer TEXT;

-- Backfill observed_at from failed_at if the older column exists (idempotent)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='mailbox_auth_fails' AND column_name='failed_at'
  ) THEN
    UPDATE mailbox_auth_fails SET observed_at = failed_at WHERE observed_at = '1970-01-01'::timestamptz;
  END IF;
END$$;

-- Hot index for rate limit query: WHERE mailbox_id=$1 AND observed_at > now() - interval '1 hour'
CREATE INDEX IF NOT EXISTS idx_mailbox_auth_fails_lookup
  ON mailbox_auth_fails (mailbox_id, observed_at DESC);

INSERT INTO schema_migrations (version) VALUES ('073_mailbox_auth_lock_quarantine') ON CONFLICT DO NOTHING;
COMMIT;
