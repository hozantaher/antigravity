-- ════════════════════════════════════════════════════════════════════════
-- KT-B4 — Operator override capture for reply classifier
-- ════════════════════════════════════════════════════════════════════════
--
-- Goal: when an operator manually corrects the reply classification away
-- from the LLM/cron-assigned label, persist a row that the next prompt
-- iteration (KT-B2 dataset extension) can train against.
--
-- Without a dedicated table, this signal lives in nobody's lap — the LLM
-- never sees its own corrections. By capturing (text input, original
-- label, override label, operator, ts) we:
--   1. unblock prompt regression iteration on real disagreements
--   2. let KT-B6 confusion-matrix UI render `(orig × override)` cells
--   3. keep an immutable audit trail per operator action
--
-- Acceptance criteria mapped:
--   - "DB schema classifier_overrides (signál Chat A pokud chybí)"
--     (initiative B-quality, KT-B4)
--   - Idempotent: CREATE TABLE IF NOT EXISTS, re-runs are no-ops
--   - Ratchet-friendly: new column adds via ALTER ADD COLUMN IF NOT EXISTS
--
-- Memory rules:
--   feedback_no_speculation — column shape derived from initiative
--                             acceptance criteria, not invented.
--   feedback_extreme_testing — BFF-side covers ≥10 happy/edge/clamp tests.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS classifier_overrides (
    id                       SERIAL PRIMARY KEY,
    reply_id                 INT  NOT NULL,
    original_classification  TEXT,
    override_classification  TEXT NOT NULL,
    operator                 TEXT NOT NULL DEFAULT 'unknown',
    ts                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recent overrides come back fast for the confusion-matrix endpoint
-- (GET /api/classifier/overrides?days=N). DESC because the report orders
-- "newest first".
CREATE INDEX IF NOT EXISTS idx_classifier_overrides_ts
    ON classifier_overrides (ts DESC);

-- Lets `JOIN reply_inbox r ON r.id = co.reply_id` stay cheap when the UI
-- backfills extra context per row.
CREATE INDEX IF NOT EXISTS idx_classifier_overrides_reply
    ON classifier_overrides (reply_id);

COMMENT ON TABLE classifier_overrides IS
    'KT-B4: per-action audit of operator manual override on top of the '
    'cron/LLM-assigned reply classification. One row per disagreement, '
    'feeds the prompt iteration loop (KT-B2) and confusion matrix (KT-B6).';

COMMENT ON COLUMN classifier_overrides.original_classification IS
    'Snapshot of reply_inbox.classification at the moment of the override. '
    'Nullable: a reply may not have been classified by the cron yet when '
    'the operator first interacts with it.';

COMMENT ON COLUMN classifier_overrides.override_classification IS
    'New label the operator chose. Constrained at the BFF layer to the '
    'same enum as reply_inbox.classification (positive/negative/question/'
    'unsubscribe/auto_reply).';

COMMENT ON COLUMN classifier_overrides.operator IS
    'Operator identity (email, slug, or "unknown" pre-auth). The BFF '
    'reads it from the request context; the column never null so the '
    'audit row always carries something for forensics.';

-- Audit log entry (best-effort — table may not exist on a brand-new dev DB).
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
            '018_classifier_overrides',
            jsonb_build_object(
                'description',
                    'KT-B4: classifier_overrides table created for operator '
                    'override capture against LLM-assigned classification.',
                'idempotent', true,
                'reversible', true,
                'tables_added', jsonb_build_array('classifier_overrides')
            )
        );
    END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DOWN — reverse the change
-- ════════════════════════════════════════════════════════════════════════
--
-- Restores pre-018 schema. Safe to re-run.
--
--   DROP TABLE IF EXISTS classifier_overrides;
--
-- ════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── KT-B4: classifier_overrides table ready (operator override capture).'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
