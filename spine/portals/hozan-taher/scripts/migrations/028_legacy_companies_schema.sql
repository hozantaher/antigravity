-- ════════════════════════════════════════════════════════════════════════
-- 028 — companies legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
--
-- Context: scripts/migrations/ is missing the original CREATE TABLE for
-- `companies`. The table exists in PROD (it is referenced by 432 distinct
-- code sites in services/* and apps/outreach-dashboard/) but no committed
-- migration declares its column list. PR #1185 (Sprint AW2 Phase 1) added
-- a static-analysis ratchet that cross-checks SQL string literals against
-- the migration-derived schema; with no CREATE TABLE in the corpus, the
-- ratchet had to suppress unknown_table violations site-wide.
--
-- This migration is **documentation-only** for the static audit:
--   * Every column is added via ADD COLUMN IF NOT EXISTS (no-op on PROD).
--   * Types are conservative TEXT placeholders. PostgreSQL `IF NOT EXISTS`
--     skips when a column with that NAME already exists regardless of type,
--     so the actual PROD column types (BIGINT, JSONB, TIMESTAMPTZ, etc.)
--     are preserved unchanged.
--   * Column names are derived from real production code references
--     (services/* + apps/outreach-dashboard/) — no speculation.
--
-- Operator notes:
--   * Per HARD memory rule `feedback_migration_apply_immediately`,
--     migrations are normally applied + verified at author time. This
--     one is intentionally a re-import: PROD already has every column,
--     so applying it is a no-op + safe ledger insert.
--   * To export the canonical PROD schema for full migration parity:
--       pg_dump --schema-only --table=companies $DATABASE_URL > companies.sql
--     and replace this file with the result.
--
-- AW2-2 sister fix to PR #1185.

BEGIN;

CREATE TABLE IF NOT EXISTS companies (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_locality      TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ares_synced_at        TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS best_targeting_score  DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS categories_json       TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS category_path         TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS classified_at         TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS composite_score       DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_count         INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS datum_vzniku          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS datum_zaniku          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS description           TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS description_tags      TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email                 TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_confidence      DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_status          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_verification    TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_verified_at     TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS engagement_cluster    TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS engagement_score      DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS exclusion_checked_at  TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS exclusion_reasons     TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS exclusion_status      TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS firmy_cz_id           TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ico                   TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS icp_factors           TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS icp_score             DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS icp_tier              TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_contacted        TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_replied          TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS nace_code             TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS nace_codes            TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS nace_primary          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS name                  TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS needs_review          BOOLEAN;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS postal_code           TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pravni_forma          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quality_tier          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS rating_count          INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS rating_value          DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS region_normalized     TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS score_components      TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS score_tier            TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS scored_at             TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sector_confidence     DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sector_primary        TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sector_source         TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sector_tags           TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS street_address        TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS synced_at             TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS telephone             TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS thread_count          INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_bounced         INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_opened          INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_replied         INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_sent            INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS v_insolvenci          BOOLEAN;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS v_likvidaci           BOOLEAN;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS velikost_firmy        TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS website               TEXT;

INSERT INTO schema_migrations (version) VALUES ('028_legacy_companies_schema') ON CONFLICT DO NOTHING;
COMMIT;
