-- Q4.9 REMEDIATION:
-- If this migration fails with "cannot create unique index — N existing duplicate label(s)",
-- follow these steps:
--
-- 1. Identify duplicates:
--    SELECT pinned_endpoint_label, count(*) FROM outreach_mailboxes
--     WHERE pinned_endpoint_label IS NOT NULL
--     GROUP BY pinned_endpoint_label HAVING count(*) > 1;
--
-- 2. Keep only the oldest mailbox per label, NULL the rest:
--    UPDATE outreach_mailboxes SET pinned_endpoint_label = NULL
--     WHERE pinned_endpoint_label IS NOT NULL
--       AND id NOT IN (
--         SELECT min(id) FROM outreach_mailboxes
--          WHERE pinned_endpoint_label IS NOT NULL
--          GROUP BY pinned_endpoint_label
--       );
--
-- 3. Re-run this migration.

BEGIN;

-- Pre-check: žádný existing collision
DO $$
DECLARE dup_count INT;
BEGIN
  SELECT count(*) INTO dup_count
    FROM (
      SELECT pinned_endpoint_label, count(*) AS c
        FROM outreach_mailboxes
       WHERE pinned_endpoint_label IS NOT NULL
       GROUP BY pinned_endpoint_label
       HAVING count(*) > 1
    ) AS dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'cannot create unique index — % existing duplicate label(s); resolve via re-pin first', dup_count;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_mailboxes_pinned_endpoint
  ON outreach_mailboxes(pinned_endpoint_label)
  WHERE pinned_endpoint_label IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('084_endpoint_label_unique') ON CONFLICT DO NOTHING;

COMMIT;
