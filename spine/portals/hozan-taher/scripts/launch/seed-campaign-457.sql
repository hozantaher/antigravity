-- Seed campaign 457 from segment 7 (operator-only, run morning of 2026-05-06)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Naplní campaign_contacts top 100 contacts seřazených podle composite_score
-- (firma) → contacts.id (přes c.ico = co.ico). Runner.go filtruje at run-time
-- přes c.status NOT IN + suppressionFilter + dedup-guard 8 axes, takže širší
-- seed je OK — neeligible se přeskočí v Engine.Run.
--
-- 100 řádků dává runner.go prostor i pro soft-rejection cases (greylist,
-- mailbox transient bounce, atd.) — Day-1 cap přes daily_cap_per_mailbox=10
-- znamená max 40 sendů z těch 100, zbytek čeká na Day-2.
--
-- Operator execution:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/launch/seed-campaign-457.sql
--
-- Dry-run první (jen SELECT, žádný INSERT):
--   psql "$DATABASE_URL" -c "$(sed -n '/^-- DRY RUN/,/^-- DRY RUN END/p' scripts/launch/seed-campaign-457.sql)"

BEGIN;

SET LOCAL statement_timeout = '120s';

-- DRY RUN
-- Před skutečným seedem: vrať preview top-100 podle score.
SELECT
  c.id AS contact_id,
  CASE
    WHEN length(c.email) <= 6 THEN '<short>'
    ELSE substr(c.email, 1, 2) || '***@' || split_part(c.email, '@', 2)
  END AS email_redacted,
  co.composite_score,
  co.icp_tier,
  co.ico
FROM segment_memberships sm
JOIN companies co ON co.id = sm.company_id
JOIN contacts c   ON c.ico = co.ico
WHERE sm.segment_id = 7
  AND co.email_status = 'valid'
  AND co.datum_zaniku IS NULL
ORDER BY co.composite_score DESC NULLS LAST, c.id
LIMIT 10;
-- DRY RUN END

-- Real seed: INSERT top-100 (ranked) into campaign_contacts.
-- DISTINCT contact_id v ranking step kvůli duplicitám v segment ↔ companies ↔
-- contacts JOINu (firmy.cz může mít víc rows se stejným ICO; contacts tabulka
-- může mít víc rows na stejné ICO pro různé osoby ve firmě). Přebereme nejvyšší
-- composite_score per contact_id, pak top 100 podle skóre.
-- ON CONFLICT DO NOTHING zachovává idempotenci re-runu.
WITH per_contact AS (
  SELECT
    c.id AS contact_id,
    MAX(co.composite_score) AS best_score
  FROM segment_memberships sm
  JOIN companies co ON co.id = sm.company_id
  JOIN contacts c   ON c.ico = co.ico
  WHERE sm.segment_id = 7
    AND co.email_status = 'valid'
    AND co.datum_zaniku IS NULL
  GROUP BY c.id
),
ranked AS (
  SELECT
    contact_id,
    best_score,
    ROW_NUMBER() OVER (ORDER BY best_score DESC NULLS LAST, contact_id) AS rn
  FROM per_contact
)
INSERT INTO campaign_contacts (campaign_id, contact_id, status, current_step)
SELECT 457, contact_id, 'pending', 0
FROM ranked
WHERE rn <= 100
ON CONFLICT (campaign_id, contact_id) DO NOTHING;

-- Audit log entry
INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
VALUES (
  'campaign_seed', 'operator', 'campaign', '457',
  jsonb_build_object(
    'segment_id', 7,
    'rank_method', 'composite_score_desc',
    'limit', 100,
    'seeded_at', now()
  )
);

-- Verify
SELECT
  COUNT(*) AS seeded_count,
  COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
FROM campaign_contacts
WHERE campaign_id = 457;

COMMIT;
