-- ════════════════════════════════════════════════════════════════════════
-- 046 — enrichment + facts + scoring legacy import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

-- enrichment_jobs
CREATE TABLE IF NOT EXISTS enrichment_jobs (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS attempt       INTEGER;
ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS company_id    BIGINT;
ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS finished_at   TIMESTAMPTZ;
ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS last_error    TEXT;
ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS scheduled_at  TIMESTAMPTZ;
ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS source        TEXT;
ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ;
ALTER TABLE enrichment_jobs ADD COLUMN IF NOT EXISTS status        TEXT;

-- enrichment_sources
CREATE TABLE IF NOT EXISTS enrichment_sources (
    source TEXT PRIMARY KEY
);
ALTER TABLE enrichment_sources ADD COLUMN IF NOT EXISTS base_confidence    DOUBLE PRECISION;
ALTER TABLE enrichment_sources ADD COLUMN IF NOT EXISTS default_ttl_days   INTEGER;
ALTER TABLE enrichment_sources ADD COLUMN IF NOT EXISTS enabled            BOOLEAN;
ALTER TABLE enrichment_sources ADD COLUMN IF NOT EXISTS rate_limit_per_min INTEGER;

-- company_facts
CREATE TABLE IF NOT EXISTS company_facts (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE company_facts ADD COLUMN IF NOT EXISTS base_confidence DOUBLE PRECISION;
ALTER TABLE company_facts ADD COLUMN IF NOT EXISTS company_id      BIGINT;
ALTER TABLE company_facts ADD COLUMN IF NOT EXISTS fetched_at      TIMESTAMPTZ;
ALTER TABLE company_facts ADD COLUMN IF NOT EXISTS field           TEXT;
ALTER TABLE company_facts ADD COLUMN IF NOT EXISTS parser_version  TEXT;
ALTER TABLE company_facts ADD COLUMN IF NOT EXISTS source          TEXT;
ALTER TABLE company_facts ADD COLUMN IF NOT EXISTS ttl_days        INTEGER;
ALTER TABLE company_facts ADD COLUMN IF NOT EXISTS value           TEXT;

-- company_current_facts
CREATE TABLE IF NOT EXISTS company_current_facts (
    company_id BIGINT,
    field TEXT
);
ALTER TABLE company_current_facts ADD COLUMN IF NOT EXISTS base_confidence DOUBLE PRECISION;
ALTER TABLE company_current_facts ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMPTZ;
ALTER TABLE company_current_facts ADD COLUMN IF NOT EXISTS fetched_at      TIMESTAMPTZ;
ALTER TABLE company_current_facts ADD COLUMN IF NOT EXISTS source          TEXT;
ALTER TABLE company_current_facts ADD COLUMN IF NOT EXISTS ttl_days        INTEGER;
ALTER TABLE company_current_facts ADD COLUMN IF NOT EXISTS value           TEXT;

-- email_domains
CREATE TABLE IF NOT EXISTS email_domains (
    domain TEXT PRIMARY KEY
);
ALTER TABLE email_domains ADD COLUMN IF NOT EXISTS checked_at        TIMESTAMPTZ;
ALTER TABLE email_domains ADD COLUMN IF NOT EXISTS is_catch_all      BOOLEAN;
ALTER TABLE email_domains ADD COLUMN IF NOT EXISTS is_disposable     BOOLEAN;
ALTER TABLE email_domains ADD COLUMN IF NOT EXISTS is_spamtrap       BOOLEAN;
ALTER TABLE email_domains ADD COLUMN IF NOT EXISTS mx_exists         BOOLEAN;
ALTER TABLE email_domains ADD COLUMN IF NOT EXISTS mx_host           TEXT;
ALTER TABLE email_domains ADD COLUMN IF NOT EXISTS smtp_connectable  BOOLEAN;

-- email_verify_queue
CREATE TABLE IF NOT EXISTS email_verify_queue (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE email_verify_queue ADD COLUMN IF NOT EXISTS attempts      INTEGER;
ALTER TABLE email_verify_queue ADD COLUMN IF NOT EXISTS email         TEXT;
ALTER TABLE email_verify_queue ADD COLUMN IF NOT EXISTS ico           TEXT;
ALTER TABLE email_verify_queue ADD COLUMN IF NOT EXISTS last_response TEXT;
ALTER TABLE email_verify_queue ADD COLUMN IF NOT EXISTS retry_at      TIMESTAMPTZ;

-- firmy_cz_businesses
CREATE TABLE IF NOT EXISTS firmy_cz_businesses (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS address_locality TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS categories_json  TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS category_path    TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS datova_schranka  TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS description      TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS email            TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS ico              TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS name             TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS postal_code      TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS pravni_forma     TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS street_address   TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS telephone        TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS velikost_firmy   TEXT;
ALTER TABLE firmy_cz_businesses ADD COLUMN IF NOT EXISTS website          TEXT;

-- outreach_score_history
CREATE TABLE IF NOT EXISTS outreach_score_history (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE outreach_score_history ADD COLUMN IF NOT EXISTS contact_id BIGINT;
ALTER TABLE outreach_score_history ADD COLUMN IF NOT EXISTS new_score  DOUBLE PRECISION;
ALTER TABLE outreach_score_history ADD COLUMN IF NOT EXISTS new_tier   TEXT;
ALTER TABLE outreach_score_history ADD COLUMN IF NOT EXISTS old_score  DOUBLE PRECISION;
ALTER TABLE outreach_score_history ADD COLUMN IF NOT EXISTS old_tier   TEXT;
ALTER TABLE outreach_score_history ADD COLUMN IF NOT EXISTS trigger    TEXT;

-- scoring_config
CREATE TABLE IF NOT EXISTS scoring_config (
    version TEXT PRIMARY KEY
);
ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS updated_by TEXT;
ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS weights    JSONB;

INSERT INTO schema_migrations (version) VALUES ('046_legacy_enrichment_tables') ON CONFLICT DO NOTHING;
COMMIT;
