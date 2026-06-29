-- 092_campaign_contacts_updated_at.sql
--
-- Adds updated_at column to campaign_contacts.
--
-- Context: apps/outreach-dashboard/src/lib/campaign-send-batch.js writes
-- `UPDATE campaign_contacts SET status='queued', updated_at=NOW()` on 6
-- code paths (line 450, 499, etc.) plus the CLI wrapper
-- apps/outreach-dashboard/campaign-send-batch.mjs has 6 more such writes.
-- The column was never added by any prior migration. PROD DB therefore
-- threw `column "updated_at" does not exist` on every send-batch call,
-- breaking the entire BFF send path. Discovered during the campaign 457
-- misfire RCA on 2026-05-09 (third "migration_apply_immediately" HARD
-- rule violation in a single evening).
--
-- Idempotent: re-runs are safe.

BEGIN;

ALTER TABLE campaign_contacts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill existing rows so they carry a sane initial value (= created_at).
UPDATE campaign_contacts SET updated_at = created_at
 WHERE updated_at = now() AND created_at IS NOT NULL AND created_at < now() - INTERVAL '1 second';

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_updated_at
  ON campaign_contacts(updated_at);

INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
VALUES (
  'migration_apply',
  'migrations',
  'schema',
  '092_campaign_contacts_updated_at',
  jsonb_build_object(
    'columns_added', jsonb_build_array('campaign_contacts.updated_at'),
    'indexes_added', jsonb_build_array('idx_campaign_contacts_updated_at'),
    'reason', 'fix BFF send-batch column-missing error discovered during campaign 457 misfire RCA 2026-05-09'
  ),
  now()
);

COMMIT;

INSERT INTO schema_migrations (version) VALUES ('092_campaign_contacts_updated_at') ON CONFLICT DO NOTHING;
