-- ════════════════════════════════════════════════════════════════════════
-- 034 — campaign_contacts legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.
-- Note: 092_campaign_contacts_updated_at.sql adds updated_at separately.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_contacts (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS campaign_id  BIGINT;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS contact_id   BIGINT;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS current_step INTEGER;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS status       TEXT;

INSERT INTO schema_migrations (version) VALUES ('034_legacy_campaign_contacts_schema') ON CONFLICT DO NOTHING;
COMMIT;
