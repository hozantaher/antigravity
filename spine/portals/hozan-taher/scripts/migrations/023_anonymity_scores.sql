-- ════════════════════════════════════════════════════════════════════════
-- Cross-mailbox Anonymity Test — S3 score columns
-- ════════════════════════════════════════════════════════════════════════
--
-- Adds nullable scoring columns to anonymity_test_messages so that the
-- S3 anonymity-score CLI can persist computed scores + LLM judge verdicts
-- back to the analytic table.
--
-- All columns are nullable:
--   - anonymity_score  INT      0–100 rule-based composite
--   - anonymity_judge  INT      0–100 LLM-as-judge (NULL when not run)
--   - anonymity_leaks  JSONB    [{rule, severity, evidence}, …]
--   - scored_at        TIMESTAMPTZ  set to now() when the scorer runs
--
-- The scorer (cmd/anonymity-score) UPDATEs these columns per message.
-- A NULL anonymity_score means the message has not yet been scored.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE anonymity_test_messages
    ADD COLUMN IF NOT EXISTS anonymity_score int,
    ADD COLUMN IF NOT EXISTS anonymity_judge int,
    ADD COLUMN IF NOT EXISTS anonymity_leaks jsonb,
    ADD COLUMN IF NOT EXISTS scored_at       timestamptz;

COMMENT ON COLUMN anonymity_test_messages.anonymity_score IS
    'S3 rule-based composite score 0–100. NULL = not yet scored.';

COMMENT ON COLUMN anonymity_test_messages.anonymity_judge IS
    'S3 LLM-as-judge score 0–100. NULL when --llm-judge flag was not set.';

COMMENT ON COLUMN anonymity_test_messages.anonymity_leaks IS
    'S3 per-rule failure evidence: [{rule, severity, evidence}, …].';

COMMENT ON COLUMN anonymity_test_messages.scored_at IS
    'Timestamp when cmd/anonymity-score last updated this row.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DOWN — reverse the change
-- ════════════════════════════════════════════════════════════════════════
--
--   ALTER TABLE anonymity_test_messages
--       DROP COLUMN IF EXISTS anonymity_score,
--       DROP COLUMN IF EXISTS anonymity_judge,
--       DROP COLUMN IF EXISTS anonymity_leaks,
--       DROP COLUMN IF EXISTS scored_at;
--
-- ════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── S3: anonymity score columns added to anonymity_test_messages.'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
