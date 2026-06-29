-- ════════════════════════════════════════════════════════════════════════
-- 031 — campaigns legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS campaigns (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS category_match  TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS category_paths  TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS name            TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS segment_query   TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_config  JSONB;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sequence_config JSONB;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS started_at      TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS status          TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS subject         TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('031_legacy_campaigns_schema') ON CONFLICT DO NOTHING;
COMMIT;
