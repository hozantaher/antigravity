-- 054_imap_uidvalidity.sql
--
-- Adds uid_validity column to mailbox_imap_state for the Go orchestrator
-- UIDvalidity tracking (#881). When the IMAP server reports a different
-- UIDVALIDITY than what is stored, the orchestrator resets the UID watermark
-- and re-fetches all UNSEEN messages — preventing duplicate or missed replies
-- after a mailbox rebuild or server migration.
--
-- The BFF (server.js) already runs an inline:
--   ALTER TABLE mailbox_imap_state ADD COLUMN IF NOT EXISTS uid_validity INTEGER;
-- at boot time, so this migration is a NOP in environments where the BFF has
-- already applied it. We upgrade the column type to BIGINT for RFC 3501
-- compliance (UIDVALIDITY is an unsigned 32-bit integer, stored as signed 64-bit
-- here to avoid signed-overflow when close to UINT32_MAX).
--
-- Predecessor: 053_unmatched_inbound.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '053_unmatched_inbound'
  ) THEN
    RAISE EXCEPTION 'Predecessor 053_unmatched_inbound not applied';
  END IF;
END $$;

-- Add uid_validity as BIGINT (idempotent; server.js may have added it as INTEGER).
-- If the column already exists as INTEGER the ALTER TYPE below widens it safely.
ALTER TABLE mailbox_imap_state
  ADD COLUMN IF NOT EXISTS uid_validity BIGINT;

-- Widen INTEGER → BIGINT if server.js added it first.
-- USING cast is a no-op for values that fit in INT4 (which UIDVALIDITY always does).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name  = 'mailbox_imap_state'
      AND column_name = 'uid_validity'
      AND data_type   = 'integer'
  ) THEN
    ALTER TABLE mailbox_imap_state
      ALTER COLUMN uid_validity TYPE BIGINT USING uid_validity::bigint;
  END IF;
END $$;

COMMENT ON COLUMN mailbox_imap_state.uid_validity IS
  'UIDVALIDITY per RFC 3501 §2.3.1.1. Set by Go orchestrator after each IMAP SELECT.
   When the server value differs from this stored value (mailbox rebuild / migration),
   the orchestrator resets last_processed_uid to 0 and re-fetches all UNSEEN messages.';

INSERT INTO schema_migrations (version) VALUES ('054_imap_uidvalidity')
  ON CONFLICT DO NOTHING;
