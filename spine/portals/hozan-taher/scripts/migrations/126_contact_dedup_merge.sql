-- 126_contact_dedup_merge.sql
-- G3.4: Merge duplicate contacts (same email → lowest id wins as canonical)
--       Remap transactional FKs, delete dropped rows, install unique constraint.
--
-- Scope (measured 2026-05-29):
--   dupe_emails:    9,451
--   rows_to_delete: 10,915
--   reply_inbox refs:        1
--   send_events refs:       102
--   campaign_contacts refs: 784
--   channel_threads refs:     1
--
-- Strategy: lowest id = canonical (oldest record, deterministic).
-- FKs on channel_threads/contact_notes/contact_tags/email_verification_log/vehicles
-- are ON DELETE CASCADE — they will vanish when dropped rows are deleted.
-- reply_inbox, send_events, campaign_contacts have no FK constraint on contact_id
-- (nullable bigint) — must be remapped manually before DELETE.

BEGIN;

-- Step 1: Build canonical/dropped mapping into a temp table
CREATE TEMP TABLE _contact_dedup_map AS
SELECT
    MIN(c.id)                                   AS canonical_id,
    c2.id                                       AS dropped_id,
    c.email                                     AS email
FROM contacts c
JOIN contacts c2 ON LOWER(TRIM(c2.email)) = LOWER(TRIM(c.email))
               AND c2.id != c.id
WHERE c.email IS NOT NULL AND c.email != ''
GROUP BY c.email, c2.id;

-- Safety check: no canonical_id should equal a dropped_id
DO $$
DECLARE cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM _contact_dedup_map
  WHERE canonical_id = dropped_id;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'Dedup map integrity error: % rows where canonical_id = dropped_id', cnt;
  END IF;
END $$;

-- Step 2: Remap non-FK transactional tables
UPDATE reply_inbox ri
SET contact_id = m.canonical_id
FROM _contact_dedup_map m
WHERE ri.contact_id = m.dropped_id;

UPDATE send_events se
SET contact_id = m.canonical_id
FROM _contact_dedup_map m
WHERE se.contact_id = m.dropped_id;

-- campaign_contacts has (contact_id, campaign_id) as a natural key;
-- if canonical already has a row for same campaign, skip (ON CONFLICT)
-- We delete conflict rows first, then update the rest.
DELETE FROM campaign_contacts cc
USING _contact_dedup_map m
WHERE cc.contact_id = m.dropped_id
  AND EXISTS (
    SELECT 1 FROM campaign_contacts cc2
    WHERE cc2.contact_id = m.canonical_id
      AND cc2.campaign_id = cc.campaign_id
  );

UPDATE campaign_contacts cc
SET contact_id = m.canonical_id
FROM _contact_dedup_map m
WHERE cc.contact_id = m.dropped_id;

-- Step 3: Delete dropped contact rows
-- CASCADE handles: channel_threads, contact_notes, contact_tags,
--                  email_verification_log, vehicles
DELETE FROM contacts
WHERE id IN (SELECT dropped_id FROM _contact_dedup_map);

-- Step 4: Verify counts
DO $$
DECLARE
  remaining_dupes INT;
  total_contacts  INT;
BEGIN
  SELECT COUNT(*) INTO remaining_dupes
  FROM (
    SELECT email FROM contacts
    WHERE email IS NOT NULL AND email != ''
    GROUP BY email HAVING COUNT(*) > 1
  ) sub;

  SELECT COUNT(*) INTO total_contacts FROM contacts;

  RAISE NOTICE 'contacts remaining: %', total_contacts;
  RAISE NOTICE 'remaining dupe email groups: %', remaining_dupes;

  IF remaining_dupes > 0 THEN
    RAISE EXCEPTION 'Dedup incomplete: % dupe groups still exist', remaining_dupes;
  END IF;
END $$;

-- Step 5: Add unique constraint on lower(trim(email)) to prevent future dupes
-- Drop the existing non-unique index first so the UNIQUE one can replace it.
DROP INDEX IF EXISTS idx_contacts_email_lower;

CREATE UNIQUE INDEX idx_contacts_email_lower
    ON contacts (LOWER(TRIM(email)))
    WHERE email IS NOT NULL AND email != '';

-- Step 6: Audit log (email domain only — no PII per feedback_no_pii_in_logs T0)
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'contact_dedup_merge',
    'system',
    'contacts',
    NULL,
    jsonb_build_object(
        'dupe_emails_merged', (SELECT COUNT(DISTINCT email) FROM _contact_dedup_map),
        'rows_deleted',       (SELECT COUNT(*) FROM _contact_dedup_map),
        'strategy',           'lowest_id_wins'
    )
);

-- Step 7: Record migration
INSERT INTO schema_migrations (version) VALUES ('126_contact_dedup_merge') ON CONFLICT DO NOTHING;

DROP TABLE _contact_dedup_map;

COMMIT;
