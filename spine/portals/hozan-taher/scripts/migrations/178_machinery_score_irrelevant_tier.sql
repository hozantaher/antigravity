-- ════════════════════════════════════════════════════════════════════════
-- 178 — Machinery score: IRRELEVANT tier + repair campaign 457 priority scale
-- ════════════════════════════════════════════════════════════════════════
--
-- TWO PROBLEMS this fixes (diagnosed 2026-06-26 on the running campaign 457
-- "Strojírenství — výkup techniky první vlna"):
--
-- 1. CORRUPTED priority scale. `campaign_contacts.priority` (migration 111,
--    declared REAL 0.0-1.0, drives the send-batch ORDER BY priority DESC in
--    apps/outreach-dashboard/src/lib/campaign-send-batch.js) had been
--    overwritten on ~50 199 of 95 679 rows with the 0-100 `prospect_score`
--    by a historical ad-hoc PROD backfill (no committed code path writes this
--    column). Result: mixed 0-1 / 0-100 scale → every 0-100 row sorted ABOVE
--    a genuine machinery 0.95 (earthworks/trucking) contact, and tierFromPriority
--    (leadTierThresholds.js, TIER_A_MIN=0.90) mis-bucketed all 0-100 rows as
--    "A_top". Send ordering by machinery probability was effectively defeated.
--
-- 2. SCORER GAP. compute_machinery_score(category_path) had no rule for
--    obviously-non-machinery service sectors (personal care, health, sport,
--    legal/finance, retail e-shops, hospitality, real estate, education,
--    photography, associations) → they all fell to the default 0.50 (MED),
--    escaping the E-tier (<0.50) pre-launch filter. ~14k such recipients sat
--    in the 457 pending queue. These businesses never own heavy machinery for
--    výkup. (Building-material yards, agri-commodity / raw-material sellers,
--    and auto-moto services are DELIBERATELY left at 0.50 — they can operate
--    loaders/forklifts.)
--
-- WHAT THIS MIGRATION DOES (idempotent / re-run safe):
--   (a) CREATE OR REPLACE compute_machinery_score with an explicit IRRELEVANT
--       tier (0.10) for an allow-list of confirmed non-machinery lvl2
--       categories, placed before the default 0.50 so all positive machinery
--       rules still win (they return early).
--   (b) Recompute campaign_contacts.priority = compute_machinery_score(...) for
--       ALL of campaign 457 → restores a single coherent 0-1 machinery scale.
--   (c) Skip (status='skipped') the 457 PENDING rows that now score < 0.50
--       (E-tier), with provenance in details. Only touches status='pending';
--       completed/skipped/paused are left intact.
--   (d) operator_audit_log rows for each mutation (feedback_audit_log_on_mutations).
--
-- Predecessor: 177_fix_null_disease_bundle (applied 2026-06-26).
-- Schema verified 2026-06-26: campaign_contacts(priority REAL, status, details
--   jsonb), contacts(category_path), operator_audit_log(entity_id BIGINT — so
--   entity_id is numeric here, NOT a text slug).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (a) Scorer: add IRRELEVANT (0.10) tier ───────────────────────────────
CREATE OR REPLACE FUNCTION compute_machinery_score(p_category_path text) RETURNS REAL AS $$
BEGIN
  IF p_category_path IS NULL OR p_category_path = '' THEN
    RETURN 0.50;
  END IF;

  -- TOP tier (0.90-0.95): always heavy machinery
  IF p_category_path ~ '(Demolice|Bourani|Pozemni-a-vykopove|Vrtani--kopani-a-cisteni-studni|Vykopy-zakladu)' THEN
    RETURN 0.95;
  END IF;
  IF p_category_path ~ '(Nakladni-silnicni-preprava|Preprava-nadmernych|Kamionova-doprava|Preprava-s-hydraulickou-rukou|Preprava-motocyklu)' THEN
    RETURN 0.92;
  END IF;
  IF p_category_path ~ 'Stavebni-firmy > (Novostavby|Prumyslove|Dopravni)' THEN
    RETURN 0.90;
  END IF;

  -- HIGH (0.78-0.88): construction, recycling, agriculture
  IF p_category_path ~ '(Likvidace-odpadu|Recyklace-stavebnich|Spalovny|Sberny-surovin|Vykup-kovu|Vykup-katalyzatoru)' THEN
    RETURN 0.85;
  END IF;
  IF p_category_path ~ '(Vyrobci-zemedelskych-komodit|Vyrobci-osiv|Vyrobci-sazenic|Lesnictvi|Ekofarmy|Obilnarstvi|Pestovani-technickych-plodin)' THEN
    RETURN 0.85;
  END IF;
  IF p_category_path ~ 'Chov-velkych-a-strednich-hospodarskych-zvirat' THEN
    RETURN 0.80;
  END IF;
  IF p_category_path ~ '(Vyrobni-haly|Prumyslove-stavby|Komercni-stavby|Vodohospodarske-stavby)' THEN
    RETURN 0.82;
  END IF;
  IF p_category_path ~ 'Stavebni-firmy' THEN
    RETURN 0.80;
  END IF;
  IF p_category_path ~ '(Stavebne-remeslne-prace|Generalni-dodavatele-staveb|Bytovych-jader|Suche-stavebnictvi|Betonove-a-zelezobetonove)' THEN
    RETURN 0.78;
  END IF;

  -- MEDIUM-HIGH (0.65-0.75): ecology, dispatch services
  IF p_category_path ~ '(Odvoz-odpadnich-vod|Cisteni-a-dekontaminace|Cisteni-studni|Skladky-odpadu)' THEN
    RETURN 0.72;
  END IF;
  IF p_category_path ~ 'Ekologicke-sluzby' THEN
    RETURN 0.68;
  END IF;
  IF p_category_path ~ '(Mereni-emisi|Sanace-skod|Sanace-staveb|Sanace-betonovych|Likvidace-skod-zivelne-pohromy)' THEN
    RETURN 0.70;
  END IF;
  IF p_category_path ~ '(Stavebni-zamecnictvi|Bourani-a-asanace-staveb)' THEN
    RETURN 0.75;
  END IF;

  -- MEDIUM (0.50-0.65): specific dept of city offices, related services
  IF p_category_path ~ '(Odbory-spravy-majetku|Odbory-dopravy|Odbory-zivotniho-prostredi)' THEN
    RETURN 0.55;
  END IF;
  IF p_category_path ~ '(Kamenictvi|Kamenosocharstvi)' THEN
    RETURN 0.55;
  END IF;
  IF p_category_path ~ '(Geologicke-prace|Mereni-a-odstineni-radonu|Vyhledavani-vodnich-zdroju)' THEN
    RETURN 0.58;
  END IF;
  IF p_category_path ~ 'Stavebni-sluzby' THEN
    RETURN 0.62;
  END IF;
  IF p_category_path ~ 'Mala-zemedelska-technika|Prodejci-zemedelske-techniky' THEN
    RETURN 0.65;  -- already have, but might trade up
  END IF;

  -- LOW (0.30-0.50): institutions, design services, technical know-how
  IF p_category_path ~ 'Inzenyrske-sluzby|Projektove-prace' THEN
    RETURN 0.40;
  END IF;
  IF p_category_path ~ '(Magistraty|Obecni-urady|Mestske-urady|Urady-mestysu|Zivnostenske-urady|Ekonomicke-odbory)' THEN
    RETURN 0.35;
  END IF;
  IF p_category_path ~ '(Architekti|Geograficke-informacni|Vypracovani-modelu-a-vizualizaci|Projektovani)' THEN
    RETURN 0.30;
  END IF;

  -- IRRELEVANT (0.10) — migration 178. Confirmed non-machinery service sectors
  -- (allow-list of real lvl2 categories, segment-boundary anchored so no
  -- positive machinery path is touched). DELIBERATELY EXCLUDES building-material
  -- yards / agri-commodity & raw-material sellers / auto-moto services (they may
  -- operate loaders/forklifts) → those keep the default 0.50.
  IF p_category_path ~ '( > |^)(Sluzby-pece-o-telo|Zdravotnicke-sluzby|Sportovni-sluzby|Nakupovani-na-internetu|Sdruzeni-a-spolky|Fotograficke-sluzby|Reality|Pravni-sluzby|Ubytovaci-sluzby|Restaurace|Ucetni-sluzby|Prodejci-potravin|Jazykove-sluzby|Vyukove-sluzby|Investovani|Pocitacove-a-internetove-sluzby|Uvery-a-pujcky|Umelecke-a-zabavni-sluzby|Prodejci-textilu-odevu-a-obuvi|Bankovni-a-sporitelni-sluzby|Pojistovaci-sluzby|Prodejci-hobby-potreb|Prodejci-zdravotnickeho-zbozi-a-leciv|Kavarny|Prodejci-darkoveho-zbozi|Prodejci-potreb-pro-sportovce|Hospody-a-hostince|Prodejci-drogerie|Prodejci-nabytku|Cukrarny)( > |$)' THEN
    RETURN 0.10;
  END IF;

  -- Default for unmatched
  RETURN 0.50;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── (b) Repair: recompute priority for ALL 457 rows (single function scan) ─
-- Must be a SEPARATE statement from the skip below: a writable-CTE that both
-- reprices and skips the SAME rows in one statement applies only ONE update
-- per row, leaving overlap rows (E-tier on the old 0-100 scale) un-repriced
-- (verified failure mode in the rollback trial: gt1>0). Sequential statements
-- each see the prior statement's changes, so (c) reads the corrected priority.
-- The subquery evaluates compute_machinery_score exactly once per 457 row.
UPDATE campaign_contacts cc
   SET priority = s.m, updated_at = NOW()
  FROM (
    SELECT cc2.id AS cc_id, compute_machinery_score(c.category_path) AS m
    FROM campaign_contacts cc2
    JOIN contacts c ON c.id = cc2.contact_id
    WHERE cc2.campaign_id = 457
  ) s
 WHERE cc.id = s.cc_id
   AND cc.priority IS DISTINCT FROM s.m;

-- ── (c) Skip E-tier (<0.50) PENDING rows — uses the now-correct priority ──
UPDATE campaign_contacts cc
   SET status = 'skipped',
       details = COALESCE(cc.details, '{}'::jsonb) || jsonb_build_object(
                   'skipped_reason', 'etier_machinery_lt_0.50_mig178',
                   'skipped_by', 'migration_178',
                   'machinery_score', cc.priority
                 ),
       updated_at = NOW()
 WHERE cc.campaign_id = 457
   AND cc.status = 'pending'
   AND cc.priority < 0.50;

-- ── (d) Audit log (entity_id is BIGINT → numeric campaign id) ─────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'campaign_priority_rescored',
  'migration_178',
  'campaign',
  457,
  jsonb_build_object(
    'migration', '178_machinery_score_irrelevant_tier.sql',
    'reason', 'Repair corrupted mixed-scale priority (0-100 prospect_score overwrite) back to compute_machinery_score 0-1; add IRRELEVANT 0.10 tier; skip E-tier pending.',
    'scorer_change', 'added IRRELEVANT (0.10) allow-list tier before default 0.50'
  )
);

COMMIT;

-- ── Verify (feedback_verify_select_after_migration) ──────────────────────
\echo '── priority scale after repair (campaign 457): expect max<=0.95, gt1=0 ──'
SELECT min(priority) AS min, max(priority) AS max,
       round(avg(priority)::numeric,3) AS avg,
       count(*) FILTER (WHERE priority > 1) AS gt1_must_be_0
FROM campaign_contacts WHERE campaign_id = 457;

\echo '── campaign 457 status breakdown after skip ──'
SELECT status, count(*) AS n FROM campaign_contacts WHERE campaign_id = 457
GROUP BY status ORDER BY n DESC;

\echo '── remaining PENDING by machinery band (the corrected send queue) ──'
SELECT CASE WHEN priority >= 0.90 THEN 'A TOP 0.90-0.95'
            WHEN priority >= 0.78 THEN 'B HIGH 0.78-0.88'
            WHEN priority >= 0.65 THEN 'C MEDHIGH 0.65-0.77'
            WHEN priority >= 0.50 THEN 'D MED 0.50-0.64'
            ELSE 'E LOW <0.50 (should be ~0)' END AS band,
       count(*) AS n
FROM campaign_contacts WHERE campaign_id = 457 AND status = 'pending'
GROUP BY 1 ORDER BY 1;
