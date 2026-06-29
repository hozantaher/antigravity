-- ════════════════════════════════════════════════════════════════════════
-- 036 — leads legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.
-- Note: 009_leads_table.sql exists but does not declare every column.

BEGIN;

CREATE TABLE IF NOT EXISTS leads (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_id  BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source      TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status      TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('036_legacy_leads_schema') ON CONFLICT DO NOTHING;
COMMIT;
