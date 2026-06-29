-- 175_manual_reply_outbox_forward.sql
--
-- Forward feature ("přeposlat") — extend the EXISTING operator outbound
-- send path (manual_reply_outbox → outbound-reply dispatcher → relay
-- /v1/submit) so the same proven pipeline can deliver a message to an
-- operator-chosen THIRD-PARTY recipient (e.g. handing a hot lead to a
-- dealer), not just back to the original sender.
--
-- Design (see docs/subsystem-maps/send-paths.md): we DO NOT add a second
-- send path. The reply dispatcher derives recipient = reply_inbox.from_email
-- and the sending mailbox = reply_inbox.mailbox_id via a JOIN. Forward needs
-- only a recipient override + an optional sending-mailbox override, so we
-- add three nullable columns and let the dispatcher COALESCE over them.
--
-- New columns on manual_reply_outbox:
--   forward_to       — TEXT. NULL = reply (recipient stays reply_inbox.from_email).
--                      Non-NULL = forward; dispatcher sends here instead.
--   from_mailbox_id  — BIGINT FK outreach_mailboxes(id). NULL = use the
--                      reply's receiving mailbox. Lets a forward pick an
--                      explicit sending identity AND covers unmatched-reply
--                      forwards (reply_inbox.mailbox_id IS NULL).
--   kind             — 'reply' | 'forward'. Authoritative flag the dispatcher
--                      reads to (a) suppress In-Reply-To/References threading
--                      headers for forwards (a forward is a fresh message to a
--                      third party, not a thread continuation) and (b) skip the
--                      outreach_messages thread insert (the forward does not
--                      belong to the lead's conversation).
--
-- The recipient is stored DURABLY in forward_to (queryable disclosure record
-- for GDPR Art. 30); operator_audit_log details stay PII-light per
-- feedback_no_pii_in_commands.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded ADD CONSTRAINT.

BEGIN;

ALTER TABLE manual_reply_outbox
  ADD COLUMN IF NOT EXISTS forward_to      TEXT,
  ADD COLUMN IF NOT EXISTS from_mailbox_id BIGINT REFERENCES outreach_mailboxes(id),
  ADD COLUMN IF NOT EXISTS kind            TEXT NOT NULL DEFAULT 'reply';

-- Guard the enum-ish kind column. PostgreSQL has no ADD CONSTRAINT IF NOT
-- EXISTS, so check pg_constraint first to stay re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'manual_reply_outbox_kind_chk'
  ) THEN
    ALTER TABLE manual_reply_outbox
      ADD CONSTRAINT manual_reply_outbox_kind_chk CHECK (kind IN ('reply', 'forward'));
  END IF;
END $$;

-- Bookkeeping uses the bare '175' prefix to match the recent convention
-- (171–174 are keyed by prefix) so the BF-G3 runner's is_applied('175')
-- recognises it and never tries to re-apply.
INSERT INTO schema_migrations (migration_id, version, filename, applied_by)
VALUES ('175', '175',
        '175_manual_reply_outbox_forward.sql',
        'forward-feature-2026-06-25')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;

-- Verify (feedback_verify_select_after_migration) — run after applying:
--   \d manual_reply_outbox
-- Expect: forward_to (text), from_mailbox_id (bigint), kind (text NOT NULL
-- DEFAULT 'reply') + CHECK constraint manual_reply_outbox_kind_chk.
