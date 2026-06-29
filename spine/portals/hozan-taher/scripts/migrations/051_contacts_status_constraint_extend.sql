-- target: outreach-db only
-- ════════════════════════════════════════════════════════════════════════
-- 051 — Extend contacts_status_check to allow 'suppressed' + 'replied'
-- ════════════════════════════════════════════════════════════════════════
--
-- Predecessor: 050_crm_clients_import
--
-- Problem: The contacts_status_check constraint only allows:
--   'valid' | 'bounced' | 'blacklisted' | 'invalid' | 'unsubscribed'
--
-- This blocks two pending migrations that need to write 'suppressed' to
-- contacts.status:
--   - 005_contacts_status_sync (companion for outreach_suppressions table)
--   - 048_suppression_list_status_sync (companion for suppression_list table)
--
-- The runner.go in services/campaigns/campaign/runner.go already filters
-- on status NOT IN ('suppressed','replied','blacklisted'), so the code
-- already expects these values to be valid. The constraint was simply
-- never widened when the suppression mirror architecture was introduced.
--
-- Additionally, 'replied' is referenced by:
--   - The 048 trigger function (s11_mirror_suppression_list_to_contacts)
--     which explicitly does NOT overwrite 'replied' contacts — so the
--     value must be a valid constraint member.
--   - The reply classifier in services/campaigns which sets status='replied'.
--
-- This migration:
--   1. Drops the existing contacts_status_check constraint.
--   2. Re-adds it with 'suppressed' and 'replied' included.
--
-- Idempotent: safe to re-run. DROP CONSTRAINT IF EXISTS handles the case
-- where the constraint was already replaced. The ADD CONSTRAINT is named
-- identically to the existing one so it remains discoverable via the
-- same pg_constraint name.
--
-- After this migration, apply 048 to complete the suppression mirror.

BEGIN;

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_status_check;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_status_check CHECK (
    status = ANY (ARRAY[
      'valid'::text,
      'bounced'::text,
      'blacklisted'::text,
      'invalid'::text,
      'unsubscribed'::text,
      'suppressed'::text,
      'replied'::text
    ])
  );

-- ── Audit log ─────────────────────────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '051_contacts_status_constraint_extend',
    jsonb_build_object(
        'description', 'Extend contacts_status_check to allow suppressed + replied',
        'idempotent', true,
        'predecessor', '050_crm_clients_import',
        'unblocks', ARRAY['005_contacts_status_sync', '048_suppression_list_status_sync'],
        'old_values', ARRAY['valid','bounced','blacklisted','invalid','unsubscribed'],
        'new_values', ARRAY['valid','bounced','blacklisted','invalid','unsubscribed','suppressed','replied']
    )
);

COMMIT;

-- ── Verification (run manually after migration) ────────────────────────
--
--   -- Confirm new constraint is in place:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'contacts'::regclass AND conname = 'contacts_status_check';
--
--   -- Should show 7 values including 'suppressed' and 'replied'.

INSERT INTO schema_migrations (version) VALUES ('051_contacts_status_constraint_extend') ON CONFLICT DO NOTHING;
