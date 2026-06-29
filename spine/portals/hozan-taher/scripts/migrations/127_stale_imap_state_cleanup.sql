-- 127_stale_imap_state_cleanup.sql
-- G3.6: Delete orphaned mailbox_imap_state + mailbox_imap_circuit rows
--       for mailbox_ids that no longer exist in outreach_mailboxes.
--
-- Orphan set confirmed 2026-05-29:
--   mailbox_id IN (1053, 1054, 1056, 14227, 14228)
--   All 5 have NULL outreach_mailboxes.id → truly orphaned.
--   polled_at = 2026-05-13 (16 days ago, no recent activity).

BEGIN;

-- Verify orphans before deleting (feedback_schema_verify_before_sql T0)
DO $$
DECLARE cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM mailbox_imap_state s
  JOIN outreach_mailboxes m ON m.id = s.mailbox_id
  WHERE s.mailbox_id IN (1053, 1054, 1056, 14227, 14228);

  IF cnt > 0 THEN
    RAISE EXCEPTION 'Safety abort: % of the target mailbox_ids still exist in outreach_mailboxes', cnt;
  END IF;
END $$;

DELETE FROM mailbox_imap_state
WHERE mailbox_id IN (1053, 1054, 1056, 14227, 14228)
  AND NOT EXISTS (SELECT 1 FROM outreach_mailboxes m WHERE m.id = mailbox_id);

DELETE FROM mailbox_imap_circuit
WHERE mailbox_id IN (1053, 1054, 1056, 14227, 14228)
  AND NOT EXISTS (SELECT 1 FROM outreach_mailboxes m WHERE m.id = mailbox_id);

-- Verify (feedback_verify_select_after_migration T0)
DO $$
DECLARE
  state_remaining  INT;
  circuit_remaining INT;
BEGIN
  SELECT COUNT(*) INTO state_remaining
  FROM mailbox_imap_state
  WHERE mailbox_id IN (1053, 1054, 1056, 14227, 14228);

  SELECT COUNT(*) INTO circuit_remaining
  FROM mailbox_imap_circuit
  WHERE mailbox_id IN (1053, 1054, 1056, 14227, 14228);

  RAISE NOTICE 'mailbox_imap_state rows for target ids remaining: %', state_remaining;
  RAISE NOTICE 'mailbox_imap_circuit rows for target ids remaining: %', circuit_remaining;

  IF state_remaining > 0 OR circuit_remaining > 0 THEN
    RAISE EXCEPTION 'Cleanup incomplete: % state + % circuit rows still present',
        state_remaining, circuit_remaining;
  END IF;
END $$;

-- Audit log (feedback_audit_log_on_mutations T0)
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'cleanup_stale_imap_state',
    'system',
    'mailbox',
    NULL,
    jsonb_build_object(
        'deleted_mailbox_ids', ARRAY[1053, 1054, 1056, 14227, 14228],
        'reason', 'orphaned_no_parent_in_outreach_mailboxes',
        'last_polled_at', '2026-05-13'
    )
);

INSERT INTO schema_migrations (version) VALUES ('127_stale_imap_state_cleanup') ON CONFLICT DO NOTHING;

COMMIT;
