-- 147_reply_templates.sql
--
-- Operator response templates for positive replies (#1022 [S5.4]).
-- Background: operator triages hot-lead replies daily in the v2 Odpovědi
-- composer. Until now every reply was typed from scratch (or Ollama-drafted).
-- Canned scaffolds for the recurring výkup moves — acknowledge interest, ask
-- for photos, ask for specs, ask for location, polite decline — let the
-- operator pick → tweak → send in seconds.
--
-- Per feedback_templates_in_db (T0): templates live in DB, not the repo. This
-- migration SEEDS sensible CZ B2B výkup defaults; the operator edits/extends
-- them via SQL or a future settings UI. The repo never re-seeds an existing
-- slug (ON CONFLICT DO NOTHING) so operator edits survive re-runs.
--
-- Distinct from email_templates (campaign cold-mail bodies, render-guarded):
-- these are short interactive REPLY scaffolds, no render pipeline, no tracking.

CREATE TABLE IF NOT EXISTS reply_templates (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  body        TEXT NOT NULL,
  sort_order  INT  NOT NULL DEFAULT 100,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reply_templates_active_order
  ON reply_templates (active, sort_order)
  WHERE active = TRUE;

-- Seed CZ B2B výkup reply scaffolds. Operator-editable; not re-seeded on
-- conflict so manual edits to these slugs persist across migration re-runs.
INSERT INTO reply_templates (slug, label, body, sort_order) VALUES
  ('interest_ack', 'Zájem — domluva prohlídky',
   E'Dobrý den,\n\nděkuji za odpověď. Rádi se na techniku podíváme. Můžete prosím poslat pár fotek a lokalitu, kde stroj stojí? Ozvu se s termínem prohlídky.\n\nDěkuji a hezký den.',
   10),
  ('request_photos', 'Žádost o fotky',
   E'Dobrý den,\n\nděkuji. Pošlete prosím pár fotek stavu stroje (celkový pohled, motor, počítadlo motohodin) — ať vám můžeme dát konkrétní nabídku.\n\nDěkuji.',
   20),
  ('request_specs', 'Žádost o specifikace',
   E'Dobrý den,\n\nabychom mohli stroj ocenit, prosím o pár údajů: rok výroby, motohodiny / nájezd, technický stav a lokalitu.\n\nDěkuji.',
   30),
  ('request_location', 'Žádost o lokalitu',
   E'Dobrý den,\n\nděkuji za info. Kde stroj aktuálně stojí (město / okres)? Domluvíme prohlídku.\n\nDěkuji.',
   40),
  ('polite_decline', 'Zdvořilé odmítnutí',
   E'Dobrý den,\n\nděkuji za informace. Tento typ techniky aktuálně nevykupujeme, ale ozveme se, pokud se to změní.\n\nHezký den.',
   90)
ON CONFLICT (slug) DO NOTHING;
