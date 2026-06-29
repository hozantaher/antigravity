-- 172_send_events_dedup_backstop.sql
--
-- DB-level backstop for the exactly-once send layer (companion to migration
-- 152 send_claims). A partial UNIQUE index so that even if something ever
-- bypasses the send_claims gate, a duplicate 'sent' row for the same
-- (campaign_id, contact_id, step) can NEVER be recorded — the second INSERT
-- is suppressed by ON CONFLICT (see the send_events INSERT sites in
-- services/orchestrator/cmd/outreach/main.go).
--
-- NONTRANSACTIONAL: this file builds the index with CREATE UNIQUE INDEX
-- CONCURRENTLY so the build does not take an ACCESS EXCLUSIVE lock on the hot
-- send_events table. scripts/migrations/run.sh auto-detects CONCURRENTLY and
-- applies the whole file OUTSIDE a transaction; the dedupe pre-step below
-- manages its own explicit BEGIN/COMMIT.
--
-- Re-run safety: the dedupe UPDATE is idempotent and the index is
-- IF NOT EXISTS. If a prior CONCURRENTLY build was interrupted it may leave an
-- INVALID index — drop it manually (DROP INDEX uq_send_events_sent_cstep) then
-- re-apply.
--
-- VERIFY AFTER APPLY (feedback_verify_select_after_migration):
--   \d send_events                       -- expect uq_send_events_sent_cstep
--   SELECT campaign_id, contact_id, step, COUNT(*)
--     FROM send_events WHERE status='sent'
--       AND campaign_id IS NOT NULL AND contact_id IS NOT NULL AND step IS NOT NULL
--    GROUP BY 1,2,3 HAVING COUNT(*) > 1;  -- expect 0 rows

-- ── Step 1: collapse any pre-existing duplicate 'sent' rows ───────────────
-- The table never had a UNIQUE constraint, so historical duplicates may
-- exist (e.g. an in_flight reaper reset + re-send before this layer landed).
-- Keep the earliest 'sent' row per key; relabel the rest to 'sent_superseded'
-- (a terminal archival status outside the partial-index predicate). History
-- is preserved — no row is deleted. 'sent_superseded' is excluded from the
-- index and from active analytics; the kept 'sent' row remains canonical.
BEGIN;

WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY campaign_id, contact_id, step
               ORDER BY sent_at ASC NULLS LAST, id ASC
           ) AS rn
      FROM send_events
     WHERE status = 'sent'
       AND campaign_id IS NOT NULL
       AND contact_id  IS NOT NULL
       AND step        IS NOT NULL
)
UPDATE send_events se
   SET status = 'sent_superseded'
  FROM ranked
 WHERE se.id = ranked.id
   AND ranked.rn > 1;

-- Guard: abort the migration loudly if any duplicate 'sent' group remains
-- (would make the CONCURRENTLY build below fail with a less obvious error).
DO $$
DECLARE dup_groups INTEGER;
BEGIN
    SELECT COUNT(*) INTO dup_groups FROM (
        SELECT 1
          FROM send_events
         WHERE status = 'sent'
           AND campaign_id IS NOT NULL
           AND contact_id  IS NOT NULL
           AND step        IS NOT NULL
         GROUP BY campaign_id, contact_id, step
        HAVING COUNT(*) > 1
    ) d;
    IF dup_groups > 0 THEN
        RAISE EXCEPTION
            'send_events still has % duplicate (campaign,contact,step) sent group(s) after dedupe — aborting before index build',
            dup_groups;
    END IF;
END $$;

COMMIT;

-- ── Step 2: the backstop index (MUST be outside a transaction) ────────────
-- Predicate is status='sent' only (not the IS NOT NULL trio) so the
-- ON CONFLICT (campaign_id, contact_id, step) WHERE status='sent' inference
-- at the INSERT sites matches cleanly. NULL-keyed 'sent' rows (warmup probes,
-- tests) are harmless: NULLs are distinct in a unique index, so they never
-- conflict.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_send_events_sent_cstep
    ON send_events (campaign_id, contact_id, step)
    WHERE status = 'sent';
