-- ════════════════════════════════════════════════════════════════════════
-- 032 — outreach_messages legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS outreach_messages (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS body_hash         TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS body_preview      TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS bounced_at        TIMESTAMPTZ;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS clicked_at        TIMESTAMPTZ;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS delivered_at      TIMESTAMPTZ;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS direction         TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS humanize_applied  BOOLEAN;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS in_reply_to       TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS is_bump           BOOLEAN;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS mailbox_used      TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS message_id        TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS opened_at         TIMESTAMPTZ;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS references_header TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS replied_at        TIMESTAMPTZ;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS reply_type        TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS sent_at           TIMESTAMPTZ;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS sentiment         TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS smtp_response     TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS subject           TEXT;
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS thread_id         BIGINT;

INSERT INTO schema_migrations (version) VALUES ('032_legacy_outreach_messages_schema') ON CONFLICT DO NOTHING;
COMMIT;
