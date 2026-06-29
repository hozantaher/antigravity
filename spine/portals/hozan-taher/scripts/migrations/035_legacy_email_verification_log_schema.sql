-- ════════════════════════════════════════════════════════════════════════
-- 035 — email_verification_log legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.
-- Note: 067_email_verification_log_contact_id.sql already adds contact_id.

BEGIN;

CREATE TABLE IF NOT EXISTS email_verification_log (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE email_verification_log ADD COLUMN IF NOT EXISTS company_ico  TEXT;
ALTER TABLE email_verification_log ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ;
ALTER TABLE email_verification_log ADD COLUMN IF NOT EXISTS detail       TEXT;
ALTER TABLE email_verification_log ADD COLUMN IF NOT EXISTS email        TEXT;
ALTER TABLE email_verification_log ADD COLUMN IF NOT EXISTS new_status   TEXT;
ALTER TABLE email_verification_log ADD COLUMN IF NOT EXISTS old_status   TEXT;
ALTER TABLE email_verification_log ADD COLUMN IF NOT EXISTS trigger      TEXT;
ALTER TABLE email_verification_log ADD COLUMN IF NOT EXISTS verification TEXT;

INSERT INTO schema_migrations (version) VALUES ('035_legacy_email_verification_log_schema') ON CONFLICT DO NOTHING;
COMMIT;
