-- ════════════════════════════════════════════════════════════════════════
-- Sprint AH — Seed 5 campaign templates from services/campaigns/configs/templates/
--
-- Migrates the .tmpl file content for:
--   initial, followup1, final, heavy-01-intro, heavy-03-bump
-- into the email_templates DB table (T0 HARD RULE: DB authoritative).
--
-- After this migration the .tmpl files + configs/templates/ directory
-- can be deleted and template.go Render() will serve exclusively from DB.
--
-- Idempotency:
--   ON CONFLICT (name) DO UPDATE SET body=EXCLUDED.body, subject=EXCLUDED.subject
--   Safe to run multiple times — latest content always wins.
--
-- Subject: first {{/* subject: ... */}} comment line, stripped of markers.
-- Body:    full file content MINUS the {{/* subject: ... */}} comment lines.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 0. Ensure table + UNIQUE constraint exist (idempotent).
CREATE TABLE IF NOT EXISTS email_templates (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    subject    TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'email_templates_name_uniq'
          AND conrelid = 'email_templates'::regclass
    ) THEN
        ALTER TABLE email_templates
            ADD CONSTRAINT email_templates_name_uniq UNIQUE (name);
    END IF;
END $$;

-- 1. Seed 5 templates from services/campaigns/configs/templates/
--    ON CONFLICT DO UPDATE makes this idempotent with latest content.
INSERT INTO email_templates (name, subject, body)
VALUES

-- ── initial ───────────────────────────────────────────────────────────────
(
    'initial',
    'Výkup techniky — kontakt z firmy.cz',
$BODY${{/* humanize: off */}}

Dobrý den,

získal jsem na Vás kontakt v katalogu firem (firmy.cz) v rámci našeho zájmu o sourcing použité stavební a manipulační techniky.

Chtěl jsem se zeptat, zda-li Vám v současné chvíli na dvorku nestojí nějaká technika (vozidlo, kamion, bagr, nakladač, traktor...), které byste se rád zbavil, nebo zda neplánujete v dohledné době výměnu vozového parku.

Pokud ano — pošlete mi prosím fotku a TP (i kopii postačuje) na tento e-mail. V zahraničí mám odběratele, kteří berou prakticky vše. Papíry i odvoz zařídím sám.

Případně volejte 776 299 933.

Děkuji za odpověď,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.$BODY$
),

-- ── followup1 ─────────────────────────────────────────────────────────────
(
    'followup1',
    'Pripominam se - vykup techniky',
$BODY${{/* humanize: off */}}

Dobry den,

pripominam se s pred par dny - jestli mate u Vas nejakou pouzitou
techniku, kterou byste radi prodali.

Cokoli, co Vam u firmy stoji a chcete to pryc - auto, dodavka,
traktor, stroj. Vykupuju pouzitou techniku pro odberatele v zahranici,
prodavame to dal a Vy dostanete poctivou nabidku.

Staci fotka a TP na tento mail. Cenu rekneme do 24 hodin.

Pripadne 776 299 933.

Diky,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.$BODY$
),

-- ── final ─────────────────────────────────────────────────────────────────
(
    'final',
    'Posledni pokus - vykup techniky',
$BODY${{/* humanize: off */}}

Dobry den,

posledni zprava ohledne odkupu pouzite techniky.

Pokud nemate nic na prodej, vubec nevadi - dale Vas neobtezuju.
Kdyby se ale nekdy v budoucnu objevila prilezitost (auto,
dodavka, traktor, stroj), klidne se ozvete - tento mail bude
porad funkcni.

Pripadne 776 299 933.

Dekuji za cas,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.$BODY$
),

-- ── heavy-01-intro ────────────────────────────────────────────────────────
(
    'heavy-01-intro',
    'Pouzita technika u Vas?',
$BODY${{/* humanize: off */}}

Dobrý den,

{mate u Vas pouzitou techniku, ktere se chcete zbavit?|nemate u Vas nejakou pouzitou techniku, co Vam stoji bez vyuziti?|nezbyla Vam ve firme nejaka technika, co byste radi prodali?}
Auto, dodavku, traktor, stavebni stroj... cokoli.

Vykupuju pouzitou techniku pro odberatele v zahranici. V zahranici
beru prakticky vse, papiry i odvoz zaridim sam, Vy dostanete poctivou
nabidku.

Staci poslat fotku a TP (i kopii) na tento mail. Pripadne volejte
776 299 933. Zbytek zaridim.

Diky,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.$BODY$
),

-- ── heavy-03-bump ─────────────────────────────────────────────────────────
(
    'heavy-03-bump',
    'Posledni pokus - vykup techniky',
$BODY${{/* humanize: off */}}

Dobrý den,

{posledni zprava ohledne odkupu pouzite techniky.|tohle je ode mne posledni zprava k odkupu pouzite techniky.|naposledy se ptam ohledne odkupu pouzite techniky.}

Pokud nemate nic na prodej, vubec nevadi - dale Vas neobtezuju.
{Kdyby se ale nekdy v budoucnu objevila prilezitost|Pokud by se ale neco objevilo casem} (auto, dodavka, traktor, stroj),
klidne se ozvete - tento mail bude porad funkcni.

Pripadne 776 299 933.

Dekuji za cas,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.$BODY$
)

ON CONFLICT (name) DO UPDATE
    SET body    = EXCLUDED.body,
        subject = EXCLUDED.subject;

-- 2. Audit log entry (best-effort).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'operator_audit_log'
    ) THEN
        INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
        VALUES (
            'template_seed',
            'migration',
            'table',
            'email_templates',
            jsonb_build_object(
                'reason', 'Sprint AH — migrate 5 templates from .tmpl files to DB',
                'migration', '061_email_templates_seed_from_tmpl.sql',
                'templates_added', jsonb_build_array('initial', 'followup1', 'final', 'heavy-01-intro', 'heavy-03-bump'),
                'reversible', true
            )
        );
    END IF;
END $$;

COMMIT;

\echo ''
\echo '── Sprint AH: 5 campaign templates seeded from .tmpl files:'
\echo '──   initial'
\echo '──   followup1'
\echo '──   final'
\echo '──   heavy-01-intro'
\echo '──   heavy-03-bump'
\echo '──'
\echo '── ON CONFLICT DO UPDATE — re-runs are idempotent (latest body wins).'

INSERT INTO schema_migrations (version) VALUES ('061_email_templates_seed_from_tmpl') ON CONFLICT DO NOTHING;
