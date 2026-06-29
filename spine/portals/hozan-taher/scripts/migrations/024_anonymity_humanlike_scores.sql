-- ════════════════════════════════════════════════════════════════════════
-- Cross-mailbox Anonymity Test — S4 human-likeness score columns
-- ════════════════════════════════════════════════════════════════════════
--
-- Adds four columns to anonymity_test_messages so the S4 binary
-- (cmd/anonymity-humanlike) can persist its per-row scoring output.
--
-- humanlike_score     int        — 0–100 weighted score (rule-based for now)
-- humanlike_judge     int        — LLM judge score (−1 = not run, 0–100 when run)
-- humanlike_telltales jsonb      — array of {rule, severity, evidence} objects
-- humanlike_scored_at timestamptz — when the scoring run executed
--
-- Idempotent: uses ADD COLUMN IF NOT EXISTS throughout.
-- Companion migration to:
--   022_anonymity_test_messages.sql  — base table (S2)
--   (023 is owned by S3 — anonymity_score columns; see non-overlap contract)
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE anonymity_test_messages
  ADD COLUMN IF NOT EXISTS humanlike_score      int,
  ADD COLUMN IF NOT EXISTS humanlike_judge      int,
  ADD COLUMN IF NOT EXISTS humanlike_telltales  jsonb,
  ADD COLUMN IF NOT EXISTS humanlike_scored_at  timestamptz;

COMMENT ON COLUMN anonymity_test_messages.humanlike_score IS
    'S4 human-likeness weighted score (0–100). Rule-based: variance+content+heuristics '
    'capped at 100 (60% weight); LLM judge 40% weight when humanlike_judge ≥ 0.';

COMMENT ON COLUMN anonymity_test_messages.humanlike_judge IS
    'S4 LLM judge score (−1 = not run, 0–100 = LLM result). '
    'When ≥ 0: humanlike_score = round(0.6*rule + 0.4*llm).';

COMMENT ON COLUMN anonymity_test_messages.humanlike_telltales IS
    'S4 array of {rule, severity, evidence} objects emitted by the rule-based scorer. '
    'Severity: "critical" | "warn" | "info".';

COMMENT ON COLUMN anonymity_test_messages.humanlike_scored_at IS
    'Timestamp when the S4 humanlike scorer last wrote to this row.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DOWN — reverse the change
-- ════════════════════════════════════════════════════════════════════════
--
--   ALTER TABLE anonymity_test_messages
--     DROP COLUMN IF EXISTS humanlike_score,
--     DROP COLUMN IF EXISTS humanlike_judge,
--     DROP COLUMN IF EXISTS humanlike_telltales,
--     DROP COLUMN IF EXISTS humanlike_scored_at;
--
-- ════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── S4: humanlike_score columns added to anonymity_test_messages.'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
