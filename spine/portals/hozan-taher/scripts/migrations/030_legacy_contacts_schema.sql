-- ════════════════════════════════════════════════════════════════════════
-- 030 — contacts legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.
-- 26 distinct columns derived from production code references.

BEGIN;

CREATE TABLE IF NOT EXISTS contacts (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS category_path         TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_name          TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_size          TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email                 TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_confidence      DOUBLE PRECISION;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_hash            TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_status          TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verification    TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verified_at     TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verify_attempts INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verify_next_at  TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_name            TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ico                   TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS imported_at           TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS industry              TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_contacted        TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_name             TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS region                TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS score                 DOUBLE PRECISION;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source                TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status                TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS validated_at          TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS validation_result     TEXT;

INSERT INTO schema_migrations (version) VALUES ('030_legacy_contacts_schema') ON CONFLICT DO NOTHING;
COMMIT;
