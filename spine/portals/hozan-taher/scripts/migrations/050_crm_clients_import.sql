-- 050_crm_clients_import.sql
-- CRM klienti import — eWAY-CRM XLSX → systém.
--
-- Operátorská potřeba 2026-05-05: existuje 2 638 klientů v eWAY-CRM se kterými
-- jsme už v kontaktu. Outbound kampaně NESMÍ na ně rozesílat. Plus 1 441
-- aktivních obchodních případů (Stav='Začínáme') které jsou subset těch
-- klientů — tam je riziko největší (operátor je v jednání).
--
-- Tabulka crm_clients drží importované záznamy + odkazy na existující
-- companies (přes IČO) a contacts (přes email) — UI badge "CRM aktivní"
-- + dedup guard 8. osa.
--
-- Importováno přes scripts/audits/crm-import.mjs (CRM-2).

BEGIN;

CREATE TABLE IF NOT EXISTS crm_clients (
  id              BIGSERIAL PRIMARY KEY,
  -- eWAY-CRM identita
  entity_id       BIGINT,                  -- ID v eWAY (sloupec "ID entity")
  imported_from   TEXT NOT NULL,           -- 'eway-klienti' | 'eway-op-zacinam'
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Firma
  ico             TEXT,
  dic             TEXT,
  name            TEXT NOT NULL,           -- Název/Jméno

  -- Kontaktní informace
  email_primary   TEXT,                    -- "Email"
  email_secondary TEXT,                    -- "Email 2"
  email_domain    TEXT GENERATED ALWAYS AS (lower(split_part(coalesce(email_primary, email_secondary, ''), '@', 2))) STORED,
  phone_primary   TEXT,                    -- "Tel 1" / "Klient - telefon"
  phone_secondary TEXT,                    -- "Tel 2" / "Kontaktní osoba - telefon"

  -- CRM status
  crm_status      TEXT,                    -- 'Potenciální' | 'Aktuální' | 'Nezajímavý' | 'Začínáme'
  crm_relationship TEXT,                   -- 'Odběratel' | 'Dodavatel' | 'Vlastní firma'
  rating          TEXT,                    -- A/B/C/D

  -- Adresa
  city            TEXT,
  region          TEXT,
  country         TEXT,
  zip             TEXT,
  street          TEXT,

  -- CRM vlastník (kdo se firmě věnuje)
  owner_email     TEXT,                    -- "Vlastník" / "Naposledy změnil"
  last_activity   TIMESTAMPTZ,             -- "Poslední aktivita"

  -- OP-specific (pouze pro imported_from='eway-op-zacinam')
  op_code         TEXT,                    -- "Kód" (např. OP-26-276)
  op_subject      TEXT,                    -- "Předmět"
  op_opened_at    TIMESTAMPTZ,             -- "Otevřeno od"
  op_estimated_close DATE,                 -- "Odhad uzavření"

  -- Volné pole
  notes           TEXT,                    -- "Poznámka" / "Popis"

  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotent UPSERT key — re-import stejného XLSX nesmí duplikovat
  UNIQUE (imported_from, entity_id)
);

-- Lookup indexy
CREATE INDEX IF NOT EXISTS idx_crm_clients_ico
  ON crm_clients(ico) WHERE ico IS NOT NULL AND ico <> '';

CREATE INDEX IF NOT EXISTS idx_crm_clients_email_primary
  ON crm_clients(lower(trim(email_primary))) WHERE email_primary IS NOT NULL AND email_primary <> '';

CREATE INDEX IF NOT EXISTS idx_crm_clients_email_secondary
  ON crm_clients(lower(trim(email_secondary))) WHERE email_secondary IS NOT NULL AND email_secondary <> '';

CREATE INDEX IF NOT EXISTS idx_crm_clients_email_domain
  ON crm_clients(email_domain) WHERE email_domain IS NOT NULL AND email_domain <> '';

CREATE INDEX IF NOT EXISTS idx_crm_clients_status
  ON crm_clients(crm_status);

-- ── FK linkage do companies / contacts ───────────────────────────────────
-- Sloupce na companies a contacts ukazující zpět do crm_clients.
-- Nullable + ON DELETE SET NULL — když operátor smaže crm_clients řádek,
-- existující companies/contacts zůstanou intaktní, jen ztratí badge.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS crm_client_id BIGINT
  REFERENCES crm_clients(id) ON DELETE SET NULL;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS crm_client_id BIGINT
  REFERENCES crm_clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_companies_crm_client_id
  ON companies(crm_client_id) WHERE crm_client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_crm_client_id
  ON contacts(crm_client_id) WHERE crm_client_id IS NOT NULL;

-- Audit log
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
VALUES (
  'migration_apply',
  'migrations',
  'schema',
  '050_crm_clients_import',
  jsonb_build_object(
    'tables_added', jsonb_build_array('crm_clients'),
    'columns_added', jsonb_build_array('companies.crm_client_id', 'contacts.crm_client_id'),
    'indexes_added', jsonb_build_array(
      'idx_crm_clients_ico', 'idx_crm_clients_email_primary',
      'idx_crm_clients_email_secondary', 'idx_crm_clients_email_domain',
      'idx_crm_clients_status', 'idx_companies_crm_client_id',
      'idx_contacts_crm_client_id'
    ),
    'reason', 'eWAY-CRM klienti + obchodní případy import; outbound DNT integration'
  ),
  now()
);

COMMIT;

INSERT INTO schema_migrations (version) VALUES ('050_crm_clients_import') ON CONFLICT DO NOTHING;
