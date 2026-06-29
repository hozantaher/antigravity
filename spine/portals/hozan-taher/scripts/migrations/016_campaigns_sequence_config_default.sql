-- ════════════════════════════════════════════════════════════════════════
-- KT-A15 — Multi-step sequence default for campaigns.sequence_config
-- ════════════════════════════════════════════════════════════════════════
--
-- Goal: every newly created campaign starts as a 3-step sequence
-- (initial → +5d followup1 → +12d final) without relying on the dashboard
-- BFF or operator SQL to inject the default. Existing single-step
-- campaigns retain their current shape — operator must opt-in to upgrade
-- (see "OPTIONAL BACKFILL" block at the bottom; commented out by default).
--
-- Acceptance criteria mapped:
--   - "Migration: ALTER TABLE campaigns ... DEFAULT '...'" → handled here
--     (the column already exists; this migration only sets the DEFAULT).
--   - sequence_config remains JSONB (no type change).
--   - Idempotent — re-runs are a no-op.
--   - Reversible — DOWN block at the end restores empty default.
--
-- Related Go-side helpers:
--   services/campaigns/campaign/sequence.go: DefaultSequence(),
--   ValidateSequence(steps).
--
-- Memory rules:
--   feedback_no_speculation — only documented operator-visible defaults.
--   feedback_extreme_testing — Go-side covers JSON shape + edge cases.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 1. Set the column default to the 3-step sequence.
--
--    ALTER COLUMN ... SET DEFAULT is idempotent — re-running just rewrites
--    the same default literal. We do NOT touch existing rows here; backfill
--    is operator-controlled (see OPTIONAL BACKFILL).
ALTER TABLE campaigns
    ALTER COLUMN sequence_config
    SET DEFAULT '[
        {"step": 0, "delay_days": 0,  "template": "initial"},
        {"step": 1, "delay_days": 5,  "template": "followup1"},
        {"step": 2, "delay_days": 12, "template": "final"}
    ]'::jsonb;

COMMENT ON COLUMN campaigns.sequence_config IS
    'KT-A15: ordered list of {step, delay_days, template} objects. '
    'Default = 3-step (initial / +5d followup1 / +12d final). '
    'Runner advances current_step on every send; reply or suppression '
    'between steps halts the sequence at the next tick.';

-- 2. Audit log entry (best-effort — table may not exist on fresh dev DB).
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
            '016_campaigns_sequence_config_default',
            jsonb_build_object(
                'description',
                    'KT-A15: campaigns.sequence_config default = 3-step '
                    '(initial / +7d followup1 / +14d final).',
                'idempotent', true,
                'reversible', true,
                'reverses_to', '''[]''::jsonb',
                'columns_changed', jsonb_build_array('sequence_config (default)')
            )
        );
    END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- OPTIONAL BACKFILL — operator opt-in
-- ════════════════════════════════════════════════════════════════════════
--
-- Existing campaigns are NOT migrated by default — single-step soft-launch
-- campaigns (e.g. "Soft launch 001 — odkup techniky 2026-04-25") may
-- intentionally have only step 0 to avoid auto-followups.
--
-- To upgrade ALL drafts that currently hold a 1-step or empty sequence
-- to the new 3-step default, operator runs:
--
--   BEGIN;
--   UPDATE campaigns
--      SET sequence_config = '[
--          {"step": 0, "delay_days": 0,  "template": "initial"},
--          {"step": 1, "delay_days": 5,  "template": "followup1"},
--          {"step": 2, "delay_days": 12, "template": "final"}
--      ]'::jsonb,
--          updated_at = now()
--    WHERE status = 'draft'
--      AND (
--          sequence_config IS NULL
--          OR sequence_config = '[]'::jsonb
--          OR jsonb_array_length(sequence_config) = 1
--      );
--   COMMIT;
--
-- Running campaigns are NEVER auto-rewritten — operator must pause first.
--
-- ════════════════════════════════════════════════════════════════════════
-- DOWN — reverse the default change
-- ════════════════════════════════════════════════════════════════════════
--
-- Restores the empty-array default (the pre-014 behaviour).
-- Existing rows are NOT touched.
--
--   ALTER TABLE campaigns
--       ALTER COLUMN sequence_config SET DEFAULT '[]'::jsonb;
--
-- ════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── KT-A15: campaigns.sequence_config default set to 3-step.'
\echo '──   step 0  +0d  initial'
\echo '──   step 1  +5d  followup1'
\echo '──   step 2  +12d final'
\echo '──'
\echo '── Existing rows untouched. See OPTIONAL BACKFILL block to upgrade.'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
