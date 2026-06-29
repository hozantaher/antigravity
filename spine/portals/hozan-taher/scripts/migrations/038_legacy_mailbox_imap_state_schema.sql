-- ════════════════════════════════════════════════════════════════════════
-- 038 — mailbox_imap_state legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS mailbox_imap_state (
    mailbox_id BIGINT PRIMARY KEY
);

ALTER TABLE mailbox_imap_state ADD COLUMN IF NOT EXISTS last_processed_uid BIGINT;
ALTER TABLE mailbox_imap_state ADD COLUMN IF NOT EXISTS polled_at          TIMESTAMPTZ;
ALTER TABLE mailbox_imap_state ADD COLUMN IF NOT EXISTS prev_unseen        INTEGER;
ALTER TABLE mailbox_imap_state ADD COLUMN IF NOT EXISTS unseen             INTEGER;

INSERT INTO schema_migrations (version) VALUES ('038_legacy_mailbox_imap_state_schema') ON CONFLICT DO NOTHING;
COMMIT;
