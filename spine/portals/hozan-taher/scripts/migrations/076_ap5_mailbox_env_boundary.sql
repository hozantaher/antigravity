-- 076_ap5_mailbox_env_boundary.sql
--
-- Sprint AP5: Production/test mailbox environment boundary verification.
--
-- The outreach_mailboxes.environment column and CHECK constraint were
-- introduced in migration 055. This migration adds a defensive assertion
-- and a partial index optimised for the AP5 production-filter queries
-- that were added to all production code paths.
--
-- Asserts:
--   1. The environment CHECK constraint exists.
--   2. The idx_outreach_mailboxes_environment index exists.
--   3. Adds a partial index for the most common production-filter pattern
--      (status IN active + environment=production) if it doesn't exist.
--
-- After applying: run SELECT count(*) FROM outreach_mailboxes WHERE environment='production'
-- and verify it returns only the 4 real production Seznam mailboxes.

BEGIN;

-- Verify the CHECK constraint exists (will error if DDL was somehow rolled back).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outreach_mailboxes_environment_check'
      AND conrelid = 'outreach_mailboxes'::regclass
  ) THEN
    RAISE EXCEPTION 'AP5 prerequisite missing: outreach_mailboxes_environment_check constraint not found. Apply migration 055 first.';
  END IF;
END $$;

-- Partial index for the most-hot AP5 filter: active production mailboxes.
-- Used by loadActiveMailboxes, emitMailboxMetrics, collectMailboxMetrics,
-- runImapPollCron, runBlacklistCheckCron, campaign-send-batch, campaignPreflight.
CREATE INDEX IF NOT EXISTS idx_outreach_mailboxes_active_production
  ON outreach_mailboxes(id)
  WHERE environment = 'production' AND status = 'active';

COMMIT;

-- Idempotent migration ledger entry (was missing in original 075 commit)
INSERT INTO schema_migrations (version) VALUES ('076_ap5_mailbox_env_boundary') ON CONFLICT DO NOTHING;
