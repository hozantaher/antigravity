-- ════════════════════════════════════════════════════════════════════════
-- 033 — send_events legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS send_events (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE send_events ADD COLUMN IF NOT EXISTS campaign_id         BIGINT;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS contact_id          BIGINT;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS mailbox_used        TEXT;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS message_id          TEXT;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS reply_classification TEXT;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS sent_at             TIMESTAMPTZ;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS smtp_response       TEXT;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS status              TEXT;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS step                INTEGER;
ALTER TABLE send_events ADD COLUMN IF NOT EXISTS subject             TEXT;

INSERT INTO schema_migrations (version) VALUES ('033_legacy_send_events_schema') ON CONFLICT DO NOTHING;
COMMIT;
