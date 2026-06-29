-- ════════════════════════════════════════════════════════════════════════
-- 011 — outreach_contacts.status check constraint repair
-- ════════════════════════════════════════════════════════════════════════
--
-- Symptom: production logs filling with
--   [ERRO] intel recalc error error="fast recalc: pq: new row for relation
--          \"outreach_contacts\" violates check constraint
--          \"outreach_contacts_status_check\" (23514)"
--
-- Root cause: an out-of-band CHECK constraint was added (NOT VALID) with
-- the allowlist
--   ['new','validating','valid','invalid','active','bounced',
--    'unsubscribed','blacklisted','opted_out','human_handoff',
--    'paused_human','completed_no_reply','retention_expired']
-- but production code in services/contacts/enrichment/suppress.go writes
-- status='suppressed' on every SuppressEmail call. The keyword is also
-- referenced in services/campaigns/campaign/runner.go (CLAUDE.md docs)
-- and is the cascade target of the BF-E3 suppression flow. Removing it
-- from the code path is not viable; the constraint is wrong.
--
-- Two pre-existing rows (id=500122, id=496621) carried status='approved'
-- — a value never written by current code, presumably from an older
-- manual operator action. Any UPDATE on those rows (e.g. the recalc
-- bulk UPDATE) re-validated the row against the NOT VALID constraint
-- and failed. Both rows have companies.email_status='valid' so they
-- were migrated to status='valid' before this migration runs.
--
-- This migration:
--   1. Drops the old constraint (now permanent — keeps NOT VALID would
--      still allow legacy `'suppressed'` rows but block new writes).
--   2. Re-adds it with `'suppressed'` included, validated against the
--      live data so future rows must match.
--
-- Idempotent: re-running drops + re-adds the same constraint shape.

BEGIN;

ALTER TABLE outreach_contacts
    DROP CONSTRAINT IF EXISTS outreach_contacts_status_check;

ALTER TABLE outreach_contacts
    ADD CONSTRAINT outreach_contacts_status_check
    CHECK (status = ANY (ARRAY[
        'new',
        'validating',
        'valid',
        'invalid',
        'active',
        'bounced',
        'unsubscribed',
        'suppressed',
        'blacklisted',
        'opted_out',
        'human_handoff',
        'paused_human',
        'completed_no_reply',
        'retention_expired'
    ]));

INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '011_outreach_contacts_status_constraint_fix',
    jsonb_build_object(
        'description', 'Add suppressed to allowed outreach_contacts.status values',
        'idempotent', true
    )
);

COMMIT;

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
