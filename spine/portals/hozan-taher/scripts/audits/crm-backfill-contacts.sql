-- crm-backfill-contacts.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill contacts.crm_client_id from companies.crm_client_id via ICO match.
--
-- After pnpm crm:import, email-only matches may miss ~7% of CRM-linked companies.
-- This script propagates crm_client_id via ICO, filling the gap for dedup-guard
-- (which uses CRM as one of 8 dedup axes).
--
-- Idempotent: only UPDATEs where crm_client_id IS NULL, so re-running has no effect
-- after first successful run.
--
-- Audit log row tracks before/after counts for operator visibility.

BEGIN;

-- Count affected rows before update
SELECT COUNT(*) INTO __before_count
FROM contacts ct
WHERE ct.ico IS NOT NULL
  AND ct.crm_client_id IS NULL
  AND EXISTS (
    SELECT 1 FROM companies co
    WHERE co.ico = ct.ico AND co.crm_client_id IS NOT NULL
  );

-- Perform the backfill
UPDATE contacts ct
SET crm_client_id = co.crm_client_id
FROM companies co
WHERE ct.ico = co.ico
  AND ct.crm_client_id IS NULL
  AND co.crm_client_id IS NOT NULL;

-- Count affected rows after update (should be 0 on re-run)
SELECT COUNT(*) INTO __after_count
FROM contacts ct
WHERE ct.ico IS NOT NULL
  AND ct.crm_client_id IS NULL
  AND EXISTS (
    SELECT 1 FROM companies co
    WHERE co.ico = ct.ico AND co.crm_client_id IS NOT NULL
  );

-- Write audit log row
INSERT INTO operator_audit_log (action, entity_type, entity_id, details, operator_email, performed_at)
VALUES (
  'crm_backfill_contacts',
  'contacts',
  'batch_' || EXTRACT(EPOCH FROM NOW())::TEXT,
  jsonb_build_object(
    'rows_updated', __before_count,
    'remaining_null', __after_count,
    'via', 'ico_company_link'
  ),
  'operator@audit',
  NOW()
);

RAISE NOTICE 'CRM backfill complete: % rows linked via ICO', __before_count;

COMMIT;
