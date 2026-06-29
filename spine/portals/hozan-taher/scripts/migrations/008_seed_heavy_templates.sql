-- ════════════════════════════════════════════════════════════════════════
-- EPIC D / Task A3 — Seed 3 heavy-equipment Czech B2B templates
-- ════════════════════════════════════════════════════════════════════════
--
-- Seeds the `email_templates` table (created lazily by the BFF in
-- apps/outreach-dashboard/server.js) with the canonical 3-step Garaaage
-- auction sequence:
--   - heavy-01-intro     (prvokontakt — 500–600 znaků)
--   - heavy-02-followup  (follow-up +4 dny — ~400 znaků)
--   - heavy-03-bump      (bump +8 dní — ~300 znaků)
--
-- Source content adapted from services/campaigns/configs/templates/*.tmpl
-- (initial.tmpl / followup1.tmpl / final.tmpl). Light spintax {a|b|c}
-- variants are introduced in 2–3 places per body for sender-side variation
-- — semantics shared between Go (services/campaigns/content/spin.go) and
-- JS (apps/outreach-dashboard/src/lib/spintax.js).
--
-- Subject lines stay literal Czech; subject rotation lives in a separate
-- code path (Go template comments `{{/* subject: ... */}}`).
--
-- Idempotency:
--   - Adds UNIQUE constraint on name if missing (gates ON CONFLICT).
--   - INSERT ... ON CONFLICT (name) DO NOTHING — re-runs a no-op.
--
-- Compliance:
--   - Body contains `{{.UnsubURL}}` placeholder for unsubscribe footer
--     (rendered by Go sender; legal requirement).
--   - Czech body, B2B tone, sign-off "B. Maarek / Garaaage" matches the
--     persona seeded in 006_seed_multi_mailbox_pool.sql.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 0. Ensure table exists (BFF creates lazily; safe to re-CREATE).
CREATE TABLE IF NOT EXISTS email_templates (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- 1. Add UNIQUE on name (idempotent — DO block guards against re-add).
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

-- 2. Seed 3 heavy-equipment templates. ON CONFLICT keeps re-runs clean.
INSERT INTO email_templates (name, subject, body)
VALUES
    (
        'heavy-01-intro',
        'Pouzita technika u Vas?',
$BODY$Dobry den,

{mate u Vas pouzitou techniku, ktere se chcete zbavit?|nemate u Vas nejakou pouzitou techniku, co Vam stoji bez vyuziti?|nezbyla Vam ve firme nejaka technika, co byste radi prodali?}
Auto, dodavku, traktor, stavebni stroj... cokoli.

Pracuju pro portal Garaaage - aukce pouzite techniky. Dame to do aukce,
kupci proti sobe nabizi cenu a Vy dostanete nejvyssi nabidku.
{Bez poplatku, bez vyjednavani s peti lidmi.|Bez skrytych poplatku, bez handrkovani.|Bez provizi a bez ztraty casu.}

Staci poslat fotku a TP (i kopii) na tento mail. Pripadne volejte
776 299 933. Zbytek zaridim.

Diky,
B. Maarek
Garaaage

---
Pro odhlaseni odpovezte STOP nebo kliknete: {{.UnsubURL}}
$BODY$
    ),
    (
        'heavy-02-followup',
        'Pripominam se - aukce techniky',
$BODY$Dobry den,

{pripominam se s pred par dny|navazuji na svuj minuly mail|jeste se ptam} - jestli mate u Vas nejakou pouzitou techniku co
by mohla jit do aukce na Garaaage.

Cokoli, co Vam u firmy stoji a chcete to pryc - auto, dodavka,
traktor, stroj. {Aukce u nas vetsinou vynese vic nez fixni nabidka od dealera, protoze kupci proti sobe nabizi.|Nase aukce obvykle skonci nad fixni dealerskou nabidkou — kupci se prebijeji.}

Staci fotka a TP na tento mail. Cenu rekneme do 24 hodin.

Pripadne 776 299 933.

Diky,
B. Maarek
Garaaage

---
Pro odhlaseni odpovezte STOP nebo kliknete: {{.UnsubURL}}
$BODY$
    ),
    (
        'heavy-03-bump',
        'Posledni pokus - aukce techniky',
$BODY$Dobry den,

{posledni zprava ohledne aukce pouzite techniky.|tohle je ode mne posledni zprava k aukci pouzite techniky.|naposledy se ptam ohledne aukce pouzite techniky.}

Pokud nemate nic na prodej, vubec nevadi - dale Vas neobtezuju.
{Kdyby se ale nekdy v budoucnu objevila prilezitost|Pokud by se ale neco objevilo casem} (auto, dodavka, traktor, stroj),
klidne se ozvete - tento mail bude porad funkcni.

Pripadne 776 299 933.

Dekuji za cas,
B. Maarek
Garaaage

---
Pro odhlaseni odpovezte STOP nebo kliknete: {{.UnsubURL}}
$BODY$
    )
ON CONFLICT (name) DO NOTHING;

-- 3. Audit log entry (best-effort — table may not exist on fresh dev DB).
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
                'reason', 'EPIC D / A3 seed 3 heavy-equipment templates',
                'migration', '008_seed_heavy_templates.sql',
                'templates_added', jsonb_build_array('heavy-01-intro', 'heavy-02-followup', 'heavy-03-bump'),
                'reversible', true
            )
        );
    END IF;
END $$;

COMMIT;

\echo ''
\echo '── Heavy-equipment templates seeded (3 entries):'
\echo '──   heavy-01-intro     (prvokontakt)'
\echo '──   heavy-02-followup  (+4 dny)'
\echo '──   heavy-03-bump      (+8 dni)'
\echo '──'
\echo '── Re-runs are idempotent (UNIQUE on name + ON CONFLICT DO NOTHING).'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
