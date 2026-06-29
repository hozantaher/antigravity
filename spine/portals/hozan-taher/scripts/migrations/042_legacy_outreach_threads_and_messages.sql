-- ════════════════════════════════════════════════════════════════════════
-- 042 — outreach_threads + reply_inbox + outreach_events legacy import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.
-- Conversation/thread state — owned by orchestrator/thread + BFF replies.

BEGIN;

-- outreach_threads
CREATE TABLE IF NOT EXISTS outreach_threads (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS campaign_id    BIGINT;
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS contact_id     BIGINT;
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ;
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS current_step   INTEGER;
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS next_action    TEXT;
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ;
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS pause_until    TIMESTAMPTZ;
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS status         TEXT;
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ;

-- reply_inbox
CREATE TABLE IF NOT EXISTS reply_inbox (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS campaign_id    BIGINT;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS classification TEXT;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS contact_id     BIGINT;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS from_email     TEXT;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS handled        BOOLEAN;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS handled_at     TIMESTAMPTZ;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS mailbox_id     BIGINT;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS received_at    TIMESTAMPTZ;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS send_event_id  BIGINT;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS subject        TEXT;

-- outreach_events
CREATE TABLE IF NOT EXISTS outreach_events (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE outreach_events ADD COLUMN IF NOT EXISTS contact_id  BIGINT;
ALTER TABLE outreach_events ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ;
ALTER TABLE outreach_events ADD COLUMN IF NOT EXISTS event_type  TEXT;
ALTER TABLE outreach_events ADD COLUMN IF NOT EXISTS message_id  TEXT;
ALTER TABLE outreach_events ADD COLUMN IF NOT EXISTS metadata    JSONB;
ALTER TABLE outreach_events ADD COLUMN IF NOT EXISTS thread_id   BIGINT;

-- manual_reply_outbox
CREATE TABLE IF NOT EXISTS manual_reply_outbox (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE manual_reply_outbox ADD COLUMN IF NOT EXISTS body            TEXT;
ALTER TABLE manual_reply_outbox ADD COLUMN IF NOT EXISTS reply_inbox_id  BIGINT;

INSERT INTO schema_migrations (version) VALUES ('042_legacy_outreach_threads_and_messages') ON CONFLICT DO NOTHING;
COMMIT;
