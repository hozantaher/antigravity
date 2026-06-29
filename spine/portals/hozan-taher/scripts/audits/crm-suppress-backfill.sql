-- crm-suppress-backfill.sql
-- Po importu eWAY-CRM klientů populuje suppression_list všemi emaily
-- z crm_clients, aby je výběrový SELECT v runneru (suppressionFilterFor)
-- vyloučil bez ohledu na další dedup-guard logiku.
--
-- Idempotentní: ON CONFLICT DO NOTHING. Lze spouštět opakovaně po
-- každém crm-import.mjs běhu.
--
-- Čte DATABASE_URL z apps/outreach-dashboard/.env. Aggregát-only output,
-- žádné PII.
--
-- Usage:
--   pnpm crm:suppress-backfill
--   psql $DATABASE_URL -f scripts/audits/crm-suppress-backfill.sql

\set ON_ERROR_STOP on

BEGIN;

-- email_primary
INSERT INTO suppression_list (email, reason, source, suppressed_at)
SELECT DISTINCT lower(trim(email_primary)), 'crm_active_client', 'eway-import', now()
FROM crm_clients
WHERE email_primary IS NOT NULL AND email_primary <> ''
ON CONFLICT (email) DO NOTHING;

-- email_secondary
INSERT INTO suppression_list (email, reason, source, suppressed_at)
SELECT DISTINCT lower(trim(email_secondary)), 'crm_active_client', 'eway-import', now()
FROM crm_clients
WHERE email_secondary IS NOT NULL AND email_secondary <> ''
ON CONFLICT (email) DO NOTHING;

-- Audit row
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
VALUES (
  'crm_suppress_backfill',
  'crm-suppress-backfill.sql',
  'suppression_list',
  'all',
  jsonb_build_object(
    'total_in_suppression_list', (SELECT COUNT(*) FROM suppression_list WHERE source='eway-import'),
    'distinct_crm_emails', (
      SELECT COUNT(DISTINCT lower(trim(email)))
      FROM (
        SELECT email_primary AS email FROM crm_clients WHERE email_primary IS NOT NULL AND email_primary <> ''
        UNION
        SELECT email_secondary FROM crm_clients WHERE email_secondary IS NOT NULL AND email_secondary <> ''
      ) e
    )
  ),
  now()
);

COMMIT;

\echo 'Backfill complete. Counts:'
SELECT
  'suppression_list rows w/ source=eway-import' AS metric,
  COUNT(*)::int AS n
FROM suppression_list WHERE source='eway-import';
