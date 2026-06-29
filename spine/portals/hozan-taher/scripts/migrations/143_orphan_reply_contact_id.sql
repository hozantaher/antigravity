-- 143_orphan_reply_contact_id.sql
--
-- Deterministic sync repair: 4 reply_inbox rows carry a contact_id that points
-- to a non-existent contacts row (dangling FK from a deleted/merged contact).
-- None of the four resolve by from_email→contacts.email, so the honest fix is
-- to NULL the stale reference — the reply is from an unmatched sender. Surfaced
-- by the v2 odpověď↔kontakt edge work (the link landed on a 404 contact).
--
-- Idempotent: only touches rows whose contact_id has no matching contact.
-- Reversible: the prior (reply_id, old_contact_id) pairs are recorded in
-- operator_audit_log (action='reply_orphan_contact_nulled') before the update.
-- reply_inbox.contact_id has no FK constraint, hence orphans were possible.

BEGIN;

-- 1) Audit the old values first (one row per repaired reply) — reversibility.
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
SELECT 'reply_orphan_contact_nulled', 'system', 'reply_inbox', r.id,
       jsonb_build_object('old_contact_id', r.contact_id, 'reason', 'dangling_fk_no_email_match')
FROM reply_inbox r
WHERE r.contact_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = r.contact_id);

-- 2) NULL the stale references.
UPDATE reply_inbox r
SET contact_id = NULL
WHERE r.contact_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = r.contact_id);

COMMIT;

-- 3) Verify — must return 0 remaining orphans.
SELECT count(*) AS remaining_orphans
FROM reply_inbox r
WHERE r.contact_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = r.contact_id);
