-- 111_machinery_score_priority.sql
-- Lead scoring podle pravděpodobnosti že contact má machinery k výkupu.
-- Heuristika nad category_path: Demolice/Doprava/Stavebnictví/Recyklace = HIGH, Architekti/Urady = LOW.
-- Persistuje score do campaign_contacts.priority (REAL 0.0-1.0).
-- SendBatchPanel pak sorting ORDER BY priority DESC NULLS LAST, next_send_at, contact_id.

BEGIN;

-- 1. Column
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS priority REAL DEFAULT 0;
COMMENT ON COLUMN campaign_contacts.priority IS
  'Lead score 0.0-1.0 — pravděpodobnost že contact má machinery. Computed from contacts.category_path via compute_machinery_score(). Send batch helper sorts by this DESC.';

-- 2. Index (composite for cohort scan + sort)
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_priority
  ON campaign_contacts (campaign_id, status, priority DESC NULLS LAST, next_send_at)
  WHERE status IN ('pending','in_flight');

-- 3. Scoring function (IMMUTABLE — pure, indexable)
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

  -- Default for unmatched
  RETURN 0.50;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMIT;
