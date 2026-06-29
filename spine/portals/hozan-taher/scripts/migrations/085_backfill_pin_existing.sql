-- Migration 085: Backfill pinned_endpoint_label for existing production mailboxes
-- Sprint AS7 — assign an explicit 1:1 endpoint pin to all production mailboxes
-- that currently have pinned_endpoint_label IS NULL.
--
-- Strategy:
--   1. Seed a temp table of available endpoints from the known pool
--      (WIREPROXY_POOL_CONFIG labels — listed below as of 2026-05-09)
--   2. Remove endpoints that are already claimed by a pinned mailbox
--      (existing pins are never overwritten — WHERE label IS NULL guard on UPDATE)
--   3. Assign remaining free endpoints round-robin by mailbox created_at order
--
-- Idempotent: re-running has no effect because the UPDATE targets only rows
-- WHERE pinned_endpoint_label IS NULL. Already-pinned mailboxes (e.g. Goran
-- 12834 with cz-prg-wg-101) are untouched.
--
-- Failure mode: if free endpoints < unpinned mailboxes the UPDATE silently
-- pins as many as possible (endpoints.rn join will just produce fewer rows).
-- Operator should verify count afterwards.

BEGIN;

CREATE TEMP TABLE _ar7_pool_endpoints (label TEXT PRIMARY KEY);
INSERT INTO _ar7_pool_endpoints (label) VALUES
  ('cz-prg-wg-101'),
  ('cz-prg-wg-102'),
  ('cz-prg-wg-103'),
  ('cz-prg-wg-104'),
  ('sk-bts-wg-201'),
  ('sk-bts-wg-202')
ON CONFLICT DO NOTHING;

-- Remove endpoints already claimed by an existing pin
DELETE FROM _ar7_pool_endpoints
 WHERE label IN (
   SELECT DISTINCT pinned_endpoint_label
     FROM outreach_mailboxes
    WHERE pinned_endpoint_label IS NOT NULL
 );

-- Backfill: assign free endpoints to unpinned production mailboxes
-- in creation order (oldest gets lowest-numbered endpoint)
WITH unpinned AS (
  SELECT id,
         row_number() OVER (ORDER BY created_at, id) AS rn
    FROM outreach_mailboxes
   WHERE environment = 'production'
     AND pinned_endpoint_label IS NULL
     AND status NOT IN ('retired')
),
endpoints AS (
  SELECT label,
         row_number() OVER (ORDER BY label) AS rn
    FROM _ar7_pool_endpoints
)
UPDATE outreach_mailboxes
   SET pinned_endpoint_label = endpoints.label,
       pinned_endpoint_at    = NOW(),
       pinned_endpoint_by    = 'as7_backfill'
  FROM unpinned
  JOIN endpoints ON endpoints.rn = unpinned.rn
 WHERE outreach_mailboxes.id = unpinned.id;

INSERT INTO schema_migrations (version)
  VALUES ('085_backfill_pin_existing')
  ON CONFLICT DO NOTHING;

COMMIT;
