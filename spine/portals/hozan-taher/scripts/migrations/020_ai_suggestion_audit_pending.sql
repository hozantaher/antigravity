-- ════════════════════════════════════════════════════════════════════════
-- Track B — operator approval backend: extend ai_suggestion_audit CHECK
-- ════════════════════════════════════════════════════════════════════════
--
-- Migration 019 created `ai_suggestion_audit` with
--   CHECK (operator_action IN ('approved','edited','rejected'))
-- which captures the *final* operator decision but leaves no value for
-- the row's initial state when the reply→AI suggestion pipeline writes
-- a draft that has not yet been reviewed.
--
-- The operator approval queue (GET /api/operator/queue) reads exactly
-- those rows — the pending ones — so we extend the allowed set with
-- 'pending'. Existing rows keep their value (no UPDATE), the predecessor
-- migration 019 stays intact, and the BFF can now insert the initial
-- AI draft using operator_action='pending' as the queue discriminator.
--
-- Forward-compatibility:
--   - DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT — re-runnable.
--   - No data migration: 019 inserts (via DSR cascade) are not affected.
--
-- Memory rules:
--   feedback_no_speculation — value 'pending' chosen because it is the
--     direct semantic complement to ('approved','edited','rejected'); no
--     speculation about future workflow states.
--   feedback_extreme_testing — BFF contract tests cover insert/update
--     paths through the new value.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE ai_suggestion_audit
    DROP CONSTRAINT IF EXISTS ai_suggestion_audit_action_chk;

ALTER TABLE ai_suggestion_audit
    ADD CONSTRAINT ai_suggestion_audit_action_chk
    CHECK (operator_action IN ('pending','approved','edited','rejected'));

COMMENT ON COLUMN ai_suggestion_audit.operator_action IS
    'Lifecycle state: pending (initial draft, awaiting operator) → '
    'approved | edited | rejected (terminal). Track B operator queue '
    'reads where operator_action = ''pending''.';

-- ── Audit log row (best-effort — table may not exist on a brand-new dev DB).
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
            '020_ai_suggestion_audit_pending',
            jsonb_build_object(
                'description',
                    'Track B: extend ai_suggestion_audit CHECK to include '
                    '''pending'' so reply→AI pipeline can insert draft rows '
                    'before operator review.',
                'idempotent', true,
                'reversible', true,
                'predecessor', '019_audit_log_schemas'
            )
        );
    END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DOWN — reverse to 019 shape
-- ════════════════════════════════════════════════════════════════════════
--
--   ALTER TABLE ai_suggestion_audit
--       DROP CONSTRAINT IF EXISTS ai_suggestion_audit_action_chk;
--   ALTER TABLE ai_suggestion_audit
--       ADD CONSTRAINT ai_suggestion_audit_action_chk
--       CHECK (operator_action IN ('approved','edited','rejected'));
--
-- WARNING: any existing 'pending' rows will fail the down-migration.
-- ════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── Track B: ai_suggestion_audit operator_action now allows ''pending''.'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
