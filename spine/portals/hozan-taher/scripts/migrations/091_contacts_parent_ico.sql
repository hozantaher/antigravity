-- 091_contacts_parent_ico.sql
--
-- Adds the parent_ico column to contacts.
--
-- Context: services/campaigns/sender/dedup_guard.go SELECT loads
-- (dnt, lifetime_touches, email_domain, region, parent_ico, crm_client_id)
-- from contacts. Code was written assuming parent_ico already existed
-- (comment in dedup_guard.go:18 says "parent_ico + region are pre-existing
-- contacts columns") but no prior migration ever added it. PROD DB therefore
-- threw `column "parent_ico" does not exist` on every dedup-guard call,
-- triggering fail-open across the entire dedup layer. Discovered during
-- campaign 457 first-launch attempt (2026-05-09 22:15 CEST).
--
-- companies.parent_ico already exists (set by ARES sync intelligence loop
-- when a company is part of a holding structure). Backfill contacts.parent_ico
-- via JOIN companies ON contacts.ico = companies.ico.
--
-- Idempotent: re-runs are safe.

BEGIN;

-- ── Add column ────────────────────────────────────────────────────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS parent_ico TEXT;

-- ── Index for bounce-cluster queries ──────────────────────────────────────
-- dedup_guard.go runs `SELECT COUNT(*) FROM send_events se JOIN contacts c
-- WHERE c.parent_ico = $1 AND se.status='bounced'` to detect bounce clusters
-- across sibling companies. Index on parent_ico keeps that O(log N).
CREATE INDEX IF NOT EXISTS idx_contacts_parent_ico
  ON contacts(parent_ico) WHERE parent_ico IS NOT NULL AND parent_ico <> '';

-- ── Backfill from companies table via ICO match ───────────────────────────
-- Only sets where contacts.parent_ico is NULL and companies has a non-empty
-- parent_ico for that ICO. Doesn't overwrite existing values.
UPDATE contacts c
   SET parent_ico = co.parent_ico
  FROM companies co
 WHERE c.ico IS NOT NULL
   AND c.ico = co.ico
   AND c.parent_ico IS NULL
   AND co.parent_ico IS NOT NULL
   AND co.parent_ico <> '';

-- ── Audit row ─────────────────────────────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
VALUES (
  'migration_apply',
  'migrations',
  'schema',
  '091_contacts_parent_ico',
  jsonb_build_object(
    'columns_added', jsonb_build_array('contacts.parent_ico'),
    'indexes_added', jsonb_build_array('idx_contacts_parent_ico'),
    'reason', 'fix dedup_guard column-missing error discovered during campaign 457 launch attempt 2026-05-09'
  ),
  now()
);

COMMIT;

INSERT INTO schema_migrations (version) VALUES ('091_contacts_parent_ico') ON CONFLICT DO NOTHING;
