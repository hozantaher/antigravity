-- ════════════════════════════════════════════════════════════════════════
-- 040 — crm_clients legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.
-- Note: 050_crm_clients_import.sql exists but does not declare every column.

BEGIN;

CREATE TABLE IF NOT EXISTS crm_clients (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE crm_clients ADD COLUMN IF NOT EXISTS details JSONB;

INSERT INTO schema_migrations (version) VALUES ('040_legacy_crm_clients_schema') ON CONFLICT DO NOTHING;
COMMIT;
