-- ════════════════════════════════════════════════════════════════════════
-- 039 — mailbox_auth_fails legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS mailbox_auth_fails (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE mailbox_auth_fails ADD COLUMN IF NOT EXISTS failed_at     TIMESTAMPTZ;
ALTER TABLE mailbox_auth_fails ADD COLUMN IF NOT EXISTS resolved_at   TIMESTAMPTZ;
ALTER TABLE mailbox_auth_fails ADD COLUMN IF NOT EXISTS smtp_response TEXT;

INSERT INTO schema_migrations (version) VALUES ('039_legacy_mailbox_auth_fails_schema') ON CONFLICT DO NOTHING;
COMMIT;
