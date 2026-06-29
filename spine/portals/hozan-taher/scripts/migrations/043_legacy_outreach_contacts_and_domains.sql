-- ════════════════════════════════════════════════════════════════════════
-- 043 — outreach_contacts + outreach_domains + categories legacy import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

-- outreach_contacts
CREATE TABLE IF NOT EXISTS outreach_contacts (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS address              TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS category_path        TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS company_id           BIGINT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS company_name         TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS company_size         TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS description_snippet  TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS dnt                  BOOLEAN;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS domain_id            BIGINT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS email                TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS email_hash           TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS firmy_cz_id          TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS first_name           TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS ico                  TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS industry_confidence  DOUBLE PRECISION;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS industry_tags        TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS last_contacted       TIMESTAMPTZ;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS last_name            TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS last_opened          TIMESTAMPTZ;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS last_replied         TIMESTAMPTZ;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS last_score_update    TIMESTAMPTZ;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS legal_form           TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS phone                TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS postal_code          TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS region               TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS source               TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS status               TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS targeting_factors    TEXT;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS targeting_score      DOUBLE PRECISION;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS total_bounced        INTEGER;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS total_opened         INTEGER;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS total_replied        INTEGER;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS total_sent           INTEGER;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ;
ALTER TABLE outreach_contacts ADD COLUMN IF NOT EXISTS website              TEXT;

-- outreach_domains
CREATE TABLE IF NOT EXISTS outreach_domains (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS active_contacts     INTEGER;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS bounce_rate         DOUBLE PRECISION;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS daily_send_cap      INTEGER;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS domain              TEXT;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS domain_type         TEXT;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS is_suppressed       BOOLEAN;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS mx_provider         TEXT;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS mx_verified         BOOLEAN;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS suppressed_at       TIMESTAMPTZ;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS suppressed_reason   TEXT;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS total_bounced       INTEGER;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS total_complained    INTEGER;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS total_sent          INTEGER;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ;

-- categories
CREATE TABLE IF NOT EXISTS categories (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS company_count INTEGER;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS depth         INTEGER;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS name          TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_path   TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS path          TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS slug          TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('043_legacy_outreach_contacts_and_domains') ON CONFLICT DO NOTHING;
COMMIT;
