-- target: outreach-db only
-- ════════════════════════════════════════════════════════════════════════
-- S1.1 — Mirror suppression_list inserts into contacts.status
-- ════════════════════════════════════════════════════════════════════════
--
-- Predecessor: 047_email_lower_indexes
--
-- Problem: Migration 005 added a backfill + INSERT trigger that mirrors
-- outreach_suppressions writes to contacts.status='suppressed'. But the
-- system has TWO suppression tables (memory: project_two_suppression_tables):
--
--   - outreach_suppressions — written by Go (reply classifier, unsubscribe,
--     bounce cascade) via contacts/enrichment.SuppressEmail.
--   - suppression_list      — written by JS/BFF (manual ops UI add via
--     POST /api/suppression in apps/outreach-dashboard/server.js).
--
-- Migration 005 only covered the Go-side write surface. When an operator
-- flags an address as bounced / complained via the UI, the row lands in
-- suppression_list and contacts.status stays 'active'. RunCampaign in
-- services/campaigns/campaign/runner.go selects from contacts filtered by
-- status — the suppression UNION filter would catch it at send time, but
-- enrollment selection upstream still treats the contact as eligible,
-- and any code path that filters only on contacts.status (without the
-- UNION fallback) silently re-sends.
--
-- This migration:
--   1. One-time backfill: set contacts.status='suppressed' for every row
--      whose lower(trim(email)) matches an existing suppression_list
--      entry. Chunked at 50k rows (same shape as migration 005).
--   2. Trigger: on INSERT into suppression_list, mirror contacts.status.
--      Idempotent — does not downgrade rows already in 'replied' or
--      'blacklisted'.
--
-- Idempotent: re-running is safe. CREATE TRIGGER pattern uses
-- DROP TRIGGER IF EXISTS first because some Postgres versions don't
-- support CREATE TRIGGER IF NOT EXISTS.

BEGIN;

-- ── Step 1: backfill in chunks ──────────────────────────────────────────
-- Loop until no rows match. PL/pgSQL DO block; same pattern as migration
-- 005's outreach_suppressions sweep.
DO $sweep$
DECLARE
  rows_affected INTEGER := 1;
  total INTEGER := 0;
  chunk_size CONSTANT INTEGER := 50000;
BEGIN
  WHILE rows_affected > 0 LOOP
    WITH candidates AS (
      SELECT c.id
      FROM contacts c
      JOIN suppression_list s
        ON lower(trim(c.email)) = lower(trim(s.email))
      WHERE c.status NOT IN ('suppressed', 'replied', 'blacklisted')
        AND s.email IS NOT NULL
      LIMIT chunk_size
    )
    UPDATE contacts c
       SET status = 'suppressed',
           updated_at = now()
      FROM candidates
     WHERE c.id = candidates.id;
    GET DIAGNOSTICS rows_affected = ROW_COUNT;
    total := total + rows_affected;
    RAISE NOTICE 'S1.1 sweep: % rows updated (running total %)',
                 rows_affected, total;
  END LOOP;
  RAISE NOTICE 'S1.1 sweep complete: % contacts.status -> suppressed', total;
END
$sweep$;

-- ── Step 2: ongoing sync trigger ─────────────────────────────────────────
-- AFTER INSERT (ROW level) on suppression_list — mirror to contacts.status.
-- Trigger fires AFTER so we don't gate the suppression write on the mirror
-- succeeding. Mirrors the migration 005 design exactly, just on the other
-- table.

CREATE OR REPLACE FUNCTION s11_mirror_suppression_list_to_contacts()
RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.email IS NOT NULL THEN
    UPDATE contacts
       SET status = 'suppressed', updated_at = now()
     WHERE lower(trim(email)) = lower(trim(NEW.email))
       AND status NOT IN ('suppressed', 'replied', 'blacklisted');
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS s11_mirror_suppression_list ON suppression_list;
CREATE TRIGGER s11_mirror_suppression_list
AFTER INSERT ON suppression_list
FOR EACH ROW
EXECUTE FUNCTION s11_mirror_suppression_list_to_contacts();

-- ── Step 3: audit log ───────────────────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '048_suppression_list_status_sync',
    jsonb_build_object(
        'description', 'S1.1: backfill contacts.status from suppression_list + INSERT trigger',
        'idempotent', true,
        'predecessor', '047_email_lower_indexes',
        'companion_migration', '005_contacts_status_sync'
    )
);

COMMIT;

-- ── Verification queries (run manually after migration) ──────────────────
--
--  -- Should be 0: contacts NOT in suppressed/replied/blacklisted whose
--  -- email is in suppression_list.
--  SELECT COUNT(*) FROM contacts c
--  WHERE c.status NOT IN ('suppressed','replied','blacklisted')
--    AND lower(trim(c.email)) IN (SELECT lower(trim(email)) FROM suppression_list WHERE email IS NOT NULL);
--
--  -- Trigger sanity — insert test suppression then verify the mirror fired:
--  --   INSERT INTO suppression_list(email, reason) VALUES('s11-test@example.com', 'manual');
--  --   SELECT status FROM contacts WHERE lower(trim(email)) = 's11-test@example.com';

INSERT INTO schema_migrations (version) VALUES ('048_suppression_list_status_sync') ON CONFLICT DO NOTHING;
