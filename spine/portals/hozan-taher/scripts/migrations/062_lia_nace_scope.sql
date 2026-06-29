-- 062_lia_nace_scope.sql
--
-- Unifies LIA NACE scope (hardcoded in Go + JS) into operator_settings table.
--
-- Context (Sprint AI — LIA Scope Unification):
--   NACE section scope was duplicated:
--   - Go:   services/campaigns/sender/lia_scope.go:13–22
--   - JS:   apps/outreach-dashboard/src/lib/campaign-send-batch.js:122
--   Both contained identical 8-element slices ["01","41","42","43","45","46","49","77"]
--   reflecting docs/legal/lia-direct-marketing.md (v1.2, 2026-05-06).
--
--   When legal updates the LIA scope, this migration allows a single source of truth
--   in the database, refreshed via operatorconfig loader (60s TTL) instead of
--   requiring code changes.
--
-- Predecessor: 060_operator_settings.sql (table created, initial KV pairs seeded)
--
-- Apply with:
--   scripts/migrations/run.sh --apply 062
-- Or manually:
--   psql "$DATABASE_URL" -f scripts/migrations/062_lia_nace_scope.sql

BEGIN;

INSERT INTO operator_settings (key, value, updated_by)
VALUES ('lia_nace_scope', '["01","41","42","43","45","46","49","77"]', 'migration_062')
ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('062_lia_nace_scope')
ON CONFLICT (version) DO NOTHING;

COMMIT;
