-- ════════════════════════════════════════════════════════════════════════
-- BF-E3 — One-time sweep + ongoing trigger: contacts.status mirrors
--         outreach_suppressions
-- ════════════════════════════════════════════════════════════════════════
--
-- Problem: SuppressEmail in services/contacts/enrichment/suppress.go
-- updates outreach_suppressions (Schema B), outreach_contacts.status
-- (Schema B), and outreach_threads (cascade), but NEVER touches the
-- Schema A `contacts` table.
--
-- Consequence: a contact who replies "unsubscribe me" → reply classifier
-- calls SuppressEmail → outreach_suppressions row inserted → BUT the
-- contacts table still shows status='new'. RunCampaign in
-- services/campaigns/campaign/runner.go selects from `contacts` filtered
-- by status, so without the suppression filter (added in earlier
-- hardening pass) it would re-send.
--
-- This migration:
--   1. One-time backfill: set contacts.status='suppressed' for every
--      row whose lower(trim(email)) matches an existing outreach_suppressions
--      entry. Chunked at 50k rows so the migration doesn't lock the table
--      indefinitely on production.
--   2. Trigger: on INSERT into outreach_suppressions, also flip
--      contacts.status='suppressed' for the matching email. Idempotent:
--      doesn't downgrade rows already in 'replied' or 'blacklisted'.
--
-- Idempotent: re-running is safe.

BEGIN;

-- ── Step 1: backfill in chunks ──────────────────────────────────────────
-- We loop until no rows match. PL/pgSQL DO block.
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
      JOIN outreach_suppressions s
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
    RAISE NOTICE 'BF-E3 sweep: % rows updated (running total %)',
                 rows_affected, total;
  END LOOP;
  RAISE NOTICE 'BF-E3 sweep complete: % contacts.status -> suppressed', total;
END
$sweep$;

-- ── Step 2: ongoing sync trigger ─────────────────────────────────────────
-- On every INSERT into outreach_suppressions, mirror to contacts.status.
-- Trigger fires AFTER INSERT (ROW level) so we don't gate the suppression
-- write on the mirror succeeding.

CREATE OR REPLACE FUNCTION bf_e3_mirror_suppression_to_contacts()
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

DROP TRIGGER IF EXISTS bf_e3_mirror_suppression ON outreach_suppressions;
CREATE TRIGGER bf_e3_mirror_suppression
AFTER INSERT ON outreach_suppressions
FOR EACH ROW
EXECUTE FUNCTION bf_e3_mirror_suppression_to_contacts();

-- ── Step 3: audit log ───────────────────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '005_contacts_status_sync',
    jsonb_build_object(
        'description', 'BF-E3: backfill contacts.status from outreach_suppressions + INSERT trigger',
        'idempotent', true
    )
);

COMMIT;

-- ── Verification queries (run manually after migration) ──────────────────
--
--  -- Should be 0: contacts NOT in suppressed/replied/blacklisted whose
--  -- email is in outreach_suppressions.
--  SELECT COUNT(*) FROM contacts c
--  WHERE c.status NOT IN ('suppressed','replied','blacklisted')
--    AND lower(trim(c.email)) IN (SELECT lower(trim(email)) FROM outreach_suppressions WHERE email IS NOT NULL);
--
--  -- Should match suppression count after a fresh INSERT (trigger sanity).
--  -- Insert a test suppression then verify the trigger fired:
--  --   INSERT INTO outreach_suppressions(email, reason) VALUES('e3-test@example.com', 'manual');
--  --   SELECT status FROM contacts WHERE lower(trim(email)) = 'e3-test@example.com';

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
