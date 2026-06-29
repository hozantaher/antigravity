-- 146_mailbox_auth_fails_mailbox_id.sql
--
-- Fix the schema drift that broke the watchdog auth-fail alerting (RCA
-- 2026-06-01: runner logged "watchdog: list auth fails: column mailbox_id does
-- not exist"). Root cause: migration 073 CREATEd mailbox_auth_fails WITH
-- mailbox_id, but the table already existed from the legacy 039 schema
-- (id/failed_at/resolved_at/smtp_response). 073's CREATE TABLE IF NOT EXISTS
-- was skipped, and its ALTER-ADD list covered op_type/error_msg/observed_at/
-- observer but NOT mailbox_id — yet its final CREATE INDEX references
-- mailbox_id, so the whole 073 transaction errored + rolled back. Result: NONE
-- of 073's columns landed and 073 was never recorded.
--
-- This migration ALTER-ADDs every column 073 intended (idempotent), with
-- mailbox_id NULLABLE (legacy rows predate per-mailbox tracking; the Go
-- Record()/recordAuthFail always supply it for new rows, and the watchdog's
-- WHERE mailbox_id=$1 correctly excludes the historical NULL rows).

BEGIN;

ALTER TABLE mailbox_auth_fails
  ADD COLUMN IF NOT EXISTS mailbox_id  BIGINT REFERENCES outreach_mailboxes(id) ON DELETE CASCADE;
ALTER TABLE mailbox_auth_fails
  ADD COLUMN IF NOT EXISTS op_type     TEXT NOT NULL DEFAULT 'smtp_probe';
ALTER TABLE mailbox_auth_fails
  ADD COLUMN IF NOT EXISTS error_msg   TEXT;
ALTER TABLE mailbox_auth_fails
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE mailbox_auth_fails
  ADD COLUMN IF NOT EXISTS observer    TEXT;

-- Backfill observed_at from the legacy failed_at where present (idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='mailbox_auth_fails' AND column_name='failed_at') THEN
    UPDATE mailbox_auth_fails SET observed_at = failed_at
     WHERE failed_at IS NOT NULL AND observed_at = '1970-01-01'::timestamptz;
  END IF;
END$$;

-- The index 073 couldn't create (mailbox_id was missing) — now valid.
CREATE INDEX IF NOT EXISTS idx_mailbox_auth_fails_lookup
  ON mailbox_auth_fails (mailbox_id, observed_at DESC);

INSERT INTO schema_migrations (version) VALUES ('146_mailbox_auth_fails_mailbox_id')
  ON CONFLICT DO NOTHING;

COMMIT;
