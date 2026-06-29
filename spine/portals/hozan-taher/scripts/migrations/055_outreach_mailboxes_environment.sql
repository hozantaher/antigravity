-- 055_outreach_mailboxes_environment.sql
--
-- Adds an `environment` column to outreach_mailboxes to permanently isolate
-- test/dev mailboxes from production campaign sends (Sprint J3 / H6.3).
--
-- Problem: the e2e_test mailbox (id=11583, smtp_username=e2e_*@test.internal)
-- lives in the same table as production mailboxes. If its status is set to
-- 'active' (by accident or UI toggle), production campaign queries return it,
-- causing contamination — emails sent from the test identity.
--
-- Solution: add environment column with a CHECK constraint (values:
-- 'production', 'test', 'dev', 'staging'). All production queries MUST add
-- WHERE environment = 'production'. Enforced by:
--   - apps/outreach-dashboard/campaign-send-batch.mjs
--   - services/campaigns/campaign/preflight.go
--   - apps/outreach-dashboard/src/server-routes/mailboxes.js (production list)
-- Ratchet test: apps/outreach-dashboard/tests/contract/mailboxes-environment.contract.test.js
--
-- Predecessor: 054_imap_uidvalidity.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '054_imap_uidvalidity'
  ) THEN
    RAISE EXCEPTION 'Predecessor 054_imap_uidvalidity not applied';
  END IF;
END $$;

-- Add column with default 'production' so all existing rows become production.
ALTER TABLE outreach_mailboxes
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'production';

-- Add CHECK constraint (idempotent: IF NOT EXISTS via name lookup).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outreach_mailboxes_environment_check'
  ) THEN
    ALTER TABLE outreach_mailboxes
      ADD CONSTRAINT outreach_mailboxes_environment_check
      CHECK (environment IN ('production', 'test', 'dev', 'staging'));
  END IF;
END $$;

-- Index for query performance on environment filter.
CREATE INDEX IF NOT EXISTS idx_outreach_mailboxes_environment
  ON outreach_mailboxes(environment);

-- Mark e2e / test mailboxes. Matches smtp_username or from_address patterns.
UPDATE outreach_mailboxes
  SET environment = 'test'
WHERE
  smtp_username LIKE 'e2e%'
  OR smtp_username LIKE '%@test.internal'
  OR from_address LIKE 'e2e%'
  OR from_address LIKE '%@test.internal'
  OR from_address LIKE '%@example.com';

COMMENT ON COLUMN outreach_mailboxes.environment IS
  'Deployment environment: production | test | dev | staging.
   All campaign send paths MUST filter WHERE environment = ''production''.
   Test mailboxes (smtp_username LIKE e2e% or @test.internal) are environment=test
   so they can never be picked up by production queries even if status=active.
   Added in migration 055 (Sprint J3 / H6.3, 2026-05-06).';

INSERT INTO schema_migrations (version) VALUES ('055_outreach_mailboxes_environment')
  ON CONFLICT DO NOTHING;
