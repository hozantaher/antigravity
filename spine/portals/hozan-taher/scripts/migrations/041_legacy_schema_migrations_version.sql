-- ════════════════════════════════════════════════════════════════════════
-- 041 — schema_migrations.version legacy column (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
--
-- Reconciles the gap between 000_schema_migrations.sql (declares
-- migration_id, applied_at, content_sha256, …) and the legacy PROD
-- schema (declares version + applied_at, predates BF-G3). Migration
-- 099_schema_migrations_compat.sql adds the modern columns onto the
-- legacy table; this migration adds the legacy `version` column onto
-- the modern table so both layouts coexist + both spellings of INSERT
-- work.
--
-- Idempotent.

BEGIN;

ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS version TEXT;

INSERT INTO schema_migrations (version) VALUES ('041_legacy_schema_migrations_version') ON CONFLICT DO NOTHING;
COMMIT;
