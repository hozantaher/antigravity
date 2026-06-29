-- ════════════════════════════════════════════════════════════════════════
-- 037 — anonymity_test_messages legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS anonymity_test_messages (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE anonymity_test_messages ADD COLUMN IF NOT EXISTS anonymity_judge      TEXT;
ALTER TABLE anonymity_test_messages ADD COLUMN IF NOT EXISTS anonymity_leaks      TEXT;
ALTER TABLE anonymity_test_messages ADD COLUMN IF NOT EXISTS humanlike_judge      TEXT;
ALTER TABLE anonymity_test_messages ADD COLUMN IF NOT EXISTS humanlike_scored_at  TIMESTAMPTZ;
ALTER TABLE anonymity_test_messages ADD COLUMN IF NOT EXISTS humanlike_telltales  TEXT;
ALTER TABLE anonymity_test_messages ADD COLUMN IF NOT EXISTS scored_at            TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('037_legacy_anonymity_test_messages_schema') ON CONFLICT DO NOTHING;
COMMIT;
