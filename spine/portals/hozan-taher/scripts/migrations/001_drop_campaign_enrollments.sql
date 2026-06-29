-- ════════════════════════════════════════════════════════════════════════
-- S4.4 — Drop dead campaign_enrollments table
-- ════════════════════════════════════════════════════════════════════════
--
-- The table was read by exactly one BFF endpoint
-- (apps/outreach-dashboard/server.js line ~405 in /api/companies/:ico/detail)
-- and never written to anywhere. It pre-dated the campaign_contacts model
-- and is now orphan schema.
--
-- Real campaign↔contact mapping lives in `campaign_contacts` (used by
-- runner.go, BFF, all enrollment paths).
--
-- This migration is reversible (CREATE TABLE again with same shape if
-- needed) — the table has zero rows in production.
--
-- Pre-flight check: confirm zero rows + no FK references before dropping.
-- Operator runs manually:
--   psql "$DATABASE_URL" -f scripts/migrations/001_drop_campaign_enrollments.sql
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 1. Pre-flight: assert table exists + is empty + has no FK references.
DO $$
DECLARE
    tbl_exists boolean;
    row_count  bigint;
    fk_count   integer;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'campaign_enrollments'
    ) INTO tbl_exists;

    IF NOT tbl_exists THEN
        RAISE NOTICE 'campaign_enrollments table does not exist; nothing to drop';
        RETURN;
    END IF;

    EXECUTE 'SELECT COUNT(*) FROM campaign_enrollments' INTO row_count;
    IF row_count > 0 THEN
        RAISE EXCEPTION 'campaign_enrollments has % rows — drop refused. Investigate before retrying.', row_count;
    END IF;

    SELECT COUNT(*) INTO fk_count
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'campaign_enrollments';

    IF fk_count > 0 THEN
        RAISE EXCEPTION 'campaign_enrollments is referenced by % foreign keys — drop refused.', fk_count;
    END IF;

    RAISE NOTICE 'pre-flight OK: campaign_enrollments has 0 rows, 0 FK references';
END $$;

-- 2. Drop. Use IF EXISTS so re-running on already-dropped DB is no-op.
DROP TABLE IF EXISTS campaign_enrollments;

-- 3. Audit log entry so the schema change is traceable.
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'schema_drop_table',
    'migration',
    'table',
    'campaign_enrollments',
    jsonb_build_object(
        'reason', 'dead schema — never written to, replaced by campaign_contacts',
        'migration', '001_drop_campaign_enrollments.sql',
        'reversible', true
    )
);

COMMIT;

\echo '── Migration complete: campaign_enrollments dropped'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
