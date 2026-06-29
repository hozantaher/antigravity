-- target: outreach-db only
-- ════════════════════════════════════════════════════════════════════════
-- 052 — Extend contacts_status_check to allow reply classification values
-- ════════════════════════════════════════════════════════════════════════
--
-- Predecessor: 051_contacts_status_constraint_extend
--
-- Problem (F2 — adversarial data layer audit 2026-05-05):
--   apps/outreach-dashboard/server.js reply classification loop (lines
--   4282–4286) writes:
--     UPDATE contacts SET status='replied_negative' WHERE id=$1
--     UPDATE contacts SET status='replied_positive' WHERE id=$1
--     UPDATE contacts SET status='auto_reply'       WHERE id=$1
--   All three calls have .catch(() => {}) — so constraint violation 23514
--   is swallowed silently. Contact retains previous status (typically 'valid')
--   with no error surfaced to operator or Sentry.
--
--   Current constraint (migration 051) only allows:
--     valid | bounced | blacklisted | invalid | unsubscribed | suppressed | replied
--
-- Impact:
--   - Reply classification appears to succeed (no UI error) but is not
--     persisted. Contact stays 'valid' → eligible for future sends.
--   - Suppression for negative replies still fires correctly (separate
--     INSERT into suppression_list), so data subject is eventually blocked
--     by the suppression UNION gate. But contacts.status is wrong.
--   - runner.go status NOT IN list does not yet include replied_negative etc.,
--     so misclassified contacts would pass the runner gate until the
--     suppression row is also present.
--
-- This migration extends the constraint to add the three classifier values.
-- runner.go separately adds 'suppressed' to its NOT IN list (same PR).
--
-- Idempotent: re-running safe (DROP CONSTRAINT IF EXISTS pattern).

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
      'replied'::text,
      'replied_negative'::text,
      'replied_positive'::text,
      'auto_reply'::text
    ])
  );

-- ── Audit log ─────────────────────────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '052_contacts_status_constraint_v2',
    jsonb_build_object(
        'description', 'Extend contacts_status_check to allow replied_negative + replied_positive + auto_reply',
        'idempotent', true,
        'predecessor', '051_contacts_status_constraint_extend',
        'security_finding', 'F2 adversarial-data-layer-2026-05-05',
        'old_values', ARRAY['valid','bounced','blacklisted','invalid','unsubscribed','suppressed','replied'],
        'new_values', ARRAY['valid','bounced','blacklisted','invalid','unsubscribed','suppressed','replied',
                            'replied_negative','replied_positive','auto_reply']
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
--   -- Should show 10 values including replied_negative/replied_positive/auto_reply.
--
--   -- Confirm constraint blocks unknown values:
--   BEGIN;
--   UPDATE contacts SET status='garbage_value' WHERE id = (SELECT id FROM contacts LIMIT 1);
--   ROLLBACK;
--   -- Expected: ERROR 23514 (check constraint violation)

INSERT INTO schema_migrations (version) VALUES ('052_contacts_status_constraint_v2') ON CONFLICT DO NOTHING;
