-- ════════════════════════════════════════════════════════════════════════
-- KT-A5 — Staircase send infrastructure (per-step contact caps)
-- ════════════════════════════════════════════════════════════════════════
--
-- Goal: every campaign carries an explicit per-step cap of recipients so
-- the runner can implement the operator's staircase 0 → 1 → 5 → 20 → 100
-- launch pattern without operator-specific feature flags. Pre-flight,
-- dry-run and send-test machinery (KT-A5) read this column to decide
-- whether the next step's quota has been satisfied.
--
-- Default = `[1, 5, 20, 100]` (matches docs/playbooks/first-campaign-launch.md).
-- Operators may override per-campaign before activation.
--
-- Acceptance criteria mapped:
--   - "Migration 017 — staircase_max_per_step JSONB column on campaigns"
--   - Idempotent: ADD COLUMN IF NOT EXISTS, re-runs are no-ops.
--   - Reversible: DOWN block at the end drops the column.
--   - Existing rows backfilled to default automatically by the DEFAULT.
--
-- Memory rules:
--   feedback_no_speculation — array shape derived from the playbook,
--                             not invented.
--   feedback_extreme_testing — Go-side covers JSON shape + edge cases.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 1. Add the column if missing. Default = canonical staircase array.
--
--    JSONB (not JSON) so the runner can do
--    `staircase_max_per_step->2` and `jsonb_array_length(...)` without
--    a JSON cast on every read.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS staircase_max_per_step JSONB
        DEFAULT '[1, 5, 20, 100]'::jsonb;

-- 2. Backfill any existing rows that came in as NULL (e.g. table existed
--    before the DEFAULT clause). Idempotent: rows already populated are
--    untouched.
UPDATE campaigns
   SET staircase_max_per_step = '[1, 5, 20, 100]'::jsonb
 WHERE staircase_max_per_step IS NULL;

COMMENT ON COLUMN campaigns.staircase_max_per_step IS
    'KT-A5: ordered array of per-step contact caps for staircase launch '
    '(0 = dry-run; 1 = single self-test; 5 = friendly; 20 = first segment; '
    '100 = full). Runner reads this to gate AdvanceStep — only after the '
    'previous step''s count has been sent AND a 1-hour soak has elapsed.';

-- 3. Audit log entry (best-effort — table may not exist on a brand-new dev DB).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'operator_audit_log'
    ) THEN
        INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
        VALUES (
            'migration_applied',
            'migration_runner',
            'schema',
            '017_campaign_staircase',
            jsonb_build_object(
                'description',
                    'KT-A5: campaigns.staircase_max_per_step column added '
                    'with default [1, 5, 20, 100].',
                'idempotent', true,
                'reversible', true,
                'columns_added', jsonb_build_array('staircase_max_per_step')
            )
        );
    END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DOWN — reverse the change
-- ════════════════════════════════════════════════════════════════════════
--
-- Restores pre-017 schema. Safe to re-run.
--
--   ALTER TABLE campaigns DROP COLUMN IF EXISTS staircase_max_per_step;
--
-- ════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── KT-A5: campaigns.staircase_max_per_step JSONB column ready.'
\echo '──   default = [1, 5, 20, 100] (dry-run / 1 / 5 / 20 / full)'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
