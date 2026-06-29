-- 120_replies_perf_indexes.sql
--
-- AT-F3 (2026-05-19): performance indexes for /replies + /priprava-rana paths.
--
-- Background: operator reported "/replies extrémně pomalé". Endpoint
-- latency audit found /api/morning-readiness consistently 4-7s because
-- readSegmentsStep does a seq scan on companies (sector_primary filter)
-- + contacts (crm_client_id IS NULL + status filter + LOWER(email) NOT IN
-- suppressions). Each table has 300-450k rows; no usable indexes existed
-- beyond the primary key.
--
-- EXPLAIN ANALYZE confirmed:
--   Seq Scan on companies cm  ... actual time=52.230..2337.017 rows=80758
--   Seq Scan on contacts c    ... actual time=11.666..868.276  rows=302908
-- Total query time: 3517ms.
--
-- The morning-readiness handler (AT-F3) also gained a 60s in-memory cache
-- so even without these indexes the cold-hit penalty drops dramatically.
-- These indexes turn the cold hit itself into a sub-200ms response.
--
-- The orphan post-hoc match handler from PR #1469 also relies on the
-- contacts(LOWER(email)) + contacts(ico) paths, which were both seq scans
-- until this migration.
--
-- All CREATE INDEX statements use IF NOT EXISTS + CONCURRENTLY so the
-- migration is safe to re-apply and does not lock the tables during build.
-- CONCURRENTLY cannot run inside a transaction block — psql -f handles
-- each statement individually.
--
-- Predecessor: 119_recover_utf8_id504.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '119_recover_utf8_id504'
  ) THEN
    RAISE EXCEPTION 'Predecessor 119_recover_utf8_id504 not applied';
  END IF;
END $$;

-- 1. companies(sector_primary) — used by morning-readiness segments step
-- and any /companies filter. Without it the filter scan removes ~345k rows
-- of 426k for every sector lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_sector_primary
  ON companies (sector_primary)
  WHERE sector_primary IS NOT NULL;

-- 2. companies(ico) — JOIN key for contacts.ico → companies.ico. The orphan
-- post-hoc match handler (PR #1469) joins on ico; without it seq scan of
-- 426k companies per orphan-detail open.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_ico
  ON companies (ico)
  WHERE ico IS NOT NULL AND ico <> '';

-- 3. contacts(ico) — symmetric for the JOIN. The contacts table is the
-- big driver of seq scans (302k filtered rows in the EXPLAIN above).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_ico
  ON contacts (ico)
  WHERE ico IS NOT NULL AND ico <> '';

-- 4. contacts(LOWER(email)) — orphan post-hoc match handler queries
-- WHERE LOWER(ct.email) = $1 on every ThreadDetail open for an orphan.
-- Functional index so the LOWER() call is index-resolvable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_lower_email
  ON contacts (LOWER(email))
  WHERE email IS NOT NULL AND email <> '';

-- 5. contacts(crm_client_id, status) — segments step filter. Partial
-- index narrowed to the morning-readiness eligibility predicate
-- (crm_client_id IS NULL AND status NOT IN suppressed/bounced/unsubscribed).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_eligible
  ON contacts (ico)
  WHERE crm_client_id IS NULL
    AND (status IS NULL OR status NOT IN ('suppressed','bounced','unsubscribed'));

-- 6. send_events(contact_id, sent_at DESC) — orphan post-hoc handler
-- looks up the most-recent send_event per contact for the inferred
-- campaign chip. Existing send_events indexes are by campaign_id /
-- mailbox_used / rfc_message_id; nothing by contact_id alone.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_send_events_contact_id_sent_at
  ON send_events (contact_id, sent_at DESC NULLS LAST)
  WHERE contact_id IS NOT NULL;

-- Record migration. CONCURRENTLY cannot be inside a transaction so this
-- INSERT runs after all CREATE statements complete.
INSERT INTO schema_migrations (version)
  VALUES ('120_replies_perf_indexes')
  ON CONFLICT DO NOTHING;

-- Verification queries (feedback_verify_select_after_migration T0):
\echo '── New indexes created: ──'
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexname IN (
     'idx_companies_sector_primary',
     'idx_companies_ico',
     'idx_contacts_ico',
     'idx_contacts_lower_email',
     'idx_contacts_eligible',
     'idx_send_events_contact_id_sent_at'
   )
 ORDER BY indexname;

\echo '── Audit log mutation (feedback_audit_log_on_mutations T0): ──'
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'schema_migration_applied',
  'migration',
  'schema_migrations',
  '120',
  jsonb_build_object(
    'migration', '120_replies_perf_indexes.sql',
    'indexes_added', 6,
    'tables_touched', ARRAY['companies','contacts','send_events'],
    'reason', 'AT-F3: /replies + morning-readiness perf regression — seq scans on 300k+ row tables; sub-200ms target post-index.'
  )
);

\echo '── Confirm migration recorded: ──'
SELECT version FROM schema_migrations WHERE version = '120_replies_perf_indexes';
