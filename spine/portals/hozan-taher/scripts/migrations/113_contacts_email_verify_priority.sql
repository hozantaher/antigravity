-- 113_contacts_email_verify_priority.sql — Sprint J
--
-- Tier-priority ordering for the contact email-verify cron.
--
-- Background
--   The contact verify cron in
--   apps/outreach-dashboard/src/server-routes/contactVerifyCron.js
--   picks contacts due for verification (email_verify_next_at <= NOW())
--   in FIFO order. With cohort 31199 enrolled on campaign 457 the FIFO
--   pass forces A-tier leads (6 338 contacts at priority >= 0.90) to
--   wait behind D-tier and unscored contacts. This wastes the daily
--   verify budget early in the run.
--
--   Migration 111 already lands the per-cohort lead score on
--   campaign_contacts.priority (REAL 0.0-1.0). This migration hoists
--   the MAX(priority) per contact onto contacts.email_verify_priority
--   so the verify cron can ORDER BY a single, indexed REAL column
--   without joining campaign_contacts at every tick.
--
-- Schema
--   contacts.email_verify_priority REAL NOT NULL DEFAULT 0.5
--     - 0.0-1.0 lead score copy.
--     - 0.5 is the neutral default that compute_machinery_score()
--       returns for unmatched category paths (migration 111). Sticking
--       to 0.5 keeps unscored contacts in the middle of the verify
--       queue, not at the bottom.
--     - Index drives the cron's ORDER BY priority DESC, next_at ASC
--       lookup. The index is partial on rows with a verify_next_at
--       schedule to keep it small (the lifetime size of contacts is
--       much larger than the active verify cohort).
--
-- Backfill
--   contacts.email_verify_priority := COALESCE(
--     MAX(campaign_contacts.priority) FILTER (...) OVER per contact,
--     0.5,
--   )
--   - MAX so a contact enrolled on multiple campaigns gets the highest
--     tier it qualifies for on any single campaign.
--   - 0.5 fallback for contacts never enrolled (the same default as
--     the column default).
--
-- HARD RULE compliance
--   - feedback_schema_verify_before_sql (T0): `\d contacts` ran before
--     authoring this file; columns confirmed:
--       email_verify_attempts (integer), email_verify_next_at (tstz),
--       NO email_verify_priority column → ADD COLUMN, not ALTER.
--   - feedback_verify_select_after_migration (T0): operator must run
--       SELECT count(*), AVG(email_verify_priority) FROM contacts;
--     and a tier-bucket SELECT (in migration playbook) after apply.
--   - feedback_no_magic_thresholds (T0): the 0.5 default matches
--     compute_machinery_score() neutral default and TIER_D_MIN floor
--     from src/lib/leadTierThresholds.js (named constant).

BEGIN;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS email_verify_priority REAL NOT NULL DEFAULT 0.5;

COMMENT ON COLUMN contacts.email_verify_priority IS
  'Sprint J: lead-tier copy used by contactVerifyCron ORDER BY. '
  'REAL 0.0-1.0 mirroring campaign_contacts.priority (migration 111). '
  'Backfilled from MAX(campaign_contacts.priority) per contact, default 0.5. '
  'Index idx_contacts_email_verify_priority drives tier-priority verify queue ordering.';

-- Backfill from campaign_contacts. NULL → 0.5 default already in place,
-- so we only UPDATE rows where we have a non-default score to lift.
UPDATE contacts c
   SET email_verify_priority = sub.max_priority
  FROM (
    SELECT contact_id, MAX(priority) AS max_priority
      FROM campaign_contacts
     WHERE priority IS NOT NULL
       AND priority > 0
     GROUP BY contact_id
  ) sub
 WHERE c.id = sub.contact_id
   AND sub.max_priority IS DISTINCT FROM c.email_verify_priority;

-- Partial index over the active verify cohort. Mirrors the cron's
-- WHERE clause (email_verify_next_at <= NOW()) but uses IS NOT NULL
-- to keep the index stable (NOW() is not immutable so a WHERE
-- email_verify_next_at <= NOW() partial index isn't allowed).
CREATE INDEX IF NOT EXISTS idx_contacts_email_verify_priority
  ON contacts (email_verify_priority DESC NULLS LAST, email_verify_next_at ASC)
  WHERE email_verify_next_at IS NOT NULL
    AND email_status NOT IN ('bounce_hold', 'spamtrap', 'invalid');

-- Operator setting: tier-priority ordering toggle. Default true so
-- the cron picks A-tier first immediately. Operator can flip to
-- false via the dashboard to fall back to FIFO if a regression
-- shows up in production.
INSERT INTO operator_settings (key, value, description, updated_by)
VALUES (
  'verify_queue_tier_priority_enabled',
  'true',
  'Sprint J: when true (default), contactVerifyCron picks due contacts ORDER BY email_verify_priority DESC, email_verify_next_at ASC. Flip to false to fall back to FIFO ordering.',
  'migration_113'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
