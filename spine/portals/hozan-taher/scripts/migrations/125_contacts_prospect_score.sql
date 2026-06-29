-- 125_contacts_prospect_score.sql
--
-- AV-F5-A (2026-05-19): prospect scoring foundation.
--
-- Adds three columns to contacts so the AV-F5-A scorer (linear_v1) can
-- persist a 0-100 score, the compute timestamp, and a JSONB factor
-- breakdown for explainability.
--
-- Columns added:
--   prospect_score          NUMERIC(5,2)  — 0.00-100.00, clamped by scorer lib.
--   prospect_score_at       TIMESTAMPTZ   — last computed; cron uses this for
--                                           24h re-compute window.
--   prospect_score_factors  JSONB         — { icp_tier_weight, email_quality_weight,
--                                             never_contacted_weight, recency_weight,
--                                             sector_match_weight, fleet_signal_weight,
--                                             raw_components: {...},
--                                             scorer_version: 'linear_v1' }
--
-- Index added:
--   idx_contacts_prospect_score_desc  — partial DESC index on (prospect_score, last_contacted)
--                                       for crm_client_id IS NULL rows so the F5-B
--                                       "Top 1000 prospects to email next" page is sub-second.
--
-- Schema verified 2026-05-19 via `\d contacts` (none of these columns exist):
--   id, category_path, company_name, ..., crm_client_id, parent_ico,
--   email_domain (generated), lifetime_touches. No prospect_* columns.
--
-- 424 393 contacts with crm_client_id IS NULL → all candidates for scoring.
--
-- Per feedback_schema_verify_before_sql T0,
-- feedback_audit_log_on_mutations T0, and
-- feedback_verify_select_after_migration T0.
--
-- Predecessor: 124_mailbox_last_bounce_alert_at.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '124_mailbox_last_bounce_alert_at'
  ) THEN
    RAISE EXCEPTION 'Predecessor 124_mailbox_last_bounce_alert_at not applied';
  END IF;
END $$;

BEGIN;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS prospect_score         NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS prospect_score_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prospect_score_factors JSONB;

COMMENT ON COLUMN contacts.prospect_score IS
  'AV-F5-A: linear_v1 prospect score in 0.00-100.00. Computed by runProspectScoringCron every 6h, recompute window 24h. NULL = never scored yet.';

COMMENT ON COLUMN contacts.prospect_score_at IS
  'AV-F5-A: timestamp of last score compute. Cron re-scores rows older than PROSPECT_SCORE_RECOMPUTE_INTERVAL_HOURS (24h).';

COMMENT ON COLUMN contacts.prospect_score_factors IS
  'AV-F5-A: JSONB breakdown of factor weights + raw component contributions + scorer_version. Used by /api/prospects/top for explainability and by F5-B UI.';

CREATE INDEX IF NOT EXISTS idx_contacts_prospect_score_desc
  ON contacts (prospect_score DESC NULLS LAST, last_contacted ASC NULLS FIRST)
  WHERE crm_client_id IS NULL;

INSERT INTO schema_migrations (version)
  VALUES ('125_contacts_prospect_score')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification (feedback_verify_select_after_migration T0):
\echo '── Columns added: ──'
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'contacts'
   AND column_name IN ('prospect_score', 'prospect_score_at', 'prospect_score_factors')
 ORDER BY column_name;

\echo '── Index created: ──'
SELECT indexname FROM pg_indexes
 WHERE tablename = 'contacts'
   AND indexname = 'idx_contacts_prospect_score_desc';

\echo '── Migration recorded: ──'
SELECT version FROM schema_migrations WHERE version = '125_contacts_prospect_score';

\echo '── Candidate pool (crm_client_id IS NULL): ──'
SELECT COUNT(*) AS unsent_prospects FROM contacts WHERE crm_client_id IS NULL;

-- Audit log mutation (feedback_audit_log_on_mutations T0).
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'schema_migration_applied',
  'migration',
  'schema_migrations',
  '125',
  jsonb_build_object(
    'migration', '125_contacts_prospect_score.sql',
    'reason', 'AV-F5-A: prospect scoring foundation — adds prospect_score / prospect_score_at / prospect_score_factors columns + partial DESC index for the F5-B "Top 1000 prospects to email next" page.',
    'sprint', 'AV-F5-A'
  )
);
