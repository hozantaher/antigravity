-- 061_icp_sectors.sql
--
-- Creates icp_sectors table for operator-configurable ICP targeting.
-- Sprint AJ: ICP targeting DB-backed so operator can experiment without code deploys.
--
-- Migrates hardcoded values from:
--   services/contacts/classify/icp.go:21-33  (22 target sectors)
--   services/contacts/classify/nace_map.go:78-90 (11 anti-target sectors)
--   Total: 33 rows (22 target + 11 anti_target).
--
-- Predecessor: 060_operator_settings.sql
--
-- Apply with:
--   psql "$DATABASE_URL" -f scripts/migrations/061_icp_sectors.sql
-- Or via migration runner:
--   scripts/migrations/run.sh --apply 061

BEGIN;

CREATE TABLE IF NOT EXISTS icp_sectors (
  id            SERIAL      PRIMARY KEY,
  code          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('target', 'anti_target')),
  nace_prefixes TEXT[]      DEFAULT '{}',
  weight        INTEGER     NOT NULL DEFAULT 1,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT,
  UNIQUE(code, kind)
);

CREATE INDEX IF NOT EXISTS idx_icp_sectors_active
  ON icp_sectors (kind, active)
  WHERE active = true;

-- ── Target sectors — 4-digit sub-sectors first (classifier ordering) ────────
INSERT INTO icp_sectors (code, name, kind, nace_prefixes, weight, updated_by) VALUES
  ('machinery_cnc',            'CNC obrábění',              'target', ARRAY['2562','2811','2840'], 10, 'migration_061'),
  ('machinery_hydraulic',      'Hydraulika a pneumatika',   'target', ARRAY['2812','2813'],        10, 'migration_061'),
  ('machinery_agricultural',   'Zemědělská technika',       'target', ARRAY['2830'],               10, 'migration_061'),
  ('metalwork_stamping',       'Lisování kovů',             'target', ARRAY['2550'],               10, 'migration_061'),
  ('metalwork_casting',        'Slévárny',                  'target', ARRAY['2451','2452','2453','2454'], 10, 'migration_061'),
  ('automotive_parts',         'Automotive díly',           'target', ARRAY['2931','2932'],        10, 'migration_061'),
  ('construction_civil',       'Inženýrské stavby',         'target', ARRAY['4211','4212','4213','4221','4222'], 10, 'migration_061'),
  ('construction_specialized', 'Specializované stavby',     'target', ARRAY['4311','4312','4313','4321','4322','4329','4331','4332','4333','4334','4339','4391','4399'], 10, 'migration_061'),
  -- Primary target — 2-digit NACE
  ('machinery',      'Strojírenství',        'target', ARRAY['28','3312','3314','3320'], 10, 'migration_061'),
  ('metalwork',      'Kovovýroba',           'target', ARRAY['24','25'],                10, 'migration_061'),
  ('construction',   'Stavebnictví',         'target', ARRAY['41','42','43'],           10, 'migration_061'),
  ('automotive',     'Automotive',           'target', ARRAY['29','30','45'],           10, 'migration_061'),
  ('woodwork',       'Dřevozpracování',      'target', ARRAY['16','31'],                10, 'migration_061'),
  ('plastics',       'Plasty a guma',        'target', ARRAY['22'],                    10, 'migration_061'),
  ('food_processing','Potravinářství',       'target', ARRAY['10','11'],               10, 'migration_061'),
  -- Secondary
  ('agriculture',    'Zemědělství',          'target', ARRAY['01','02','03'],           5, 'migration_061'),
  ('energy',         'Energetika',           'target', ARRAY['35','36','37'],           5, 'migration_061'),
  ('transport',      'Doprava a logistika',  'target', ARRAY['49','50','51','52','53'], 5, 'migration_061'),
  ('waste',          'Odpady a recyklace',   'target', ARRAY['38','39'],                5, 'migration_061'),
  ('mining',         'Těžba',               'target', ARRAY['05','06','07','08','09'], 5, 'migration_061'),
  ('chemicals',      'Chemie a farma',       'target', ARRAY['20','21'],                5, 'migration_061'),
  ('electronics',    'Elektronika',          'target', ARRAY['26','27','95'],           5, 'migration_061')
ON CONFLICT (code, kind) DO NOTHING;

-- ── Anti-target sectors (from AntiTargetSectors map) ─────────────────────
-- These cap ICP score to irrelevant tier regardless of other signals.
INSERT INTO icp_sectors (code, name, kind, nace_prefixes, weight, updated_by) VALUES
  ('retail',            'Maloobchod',             'anti_target', ARRAY['47'],                                 0, 'migration_061'),
  ('hospitality',       'Ubytování a gastro',     'anti_target', ARRAY['55','56'],                           0, 'migration_061'),
  ('real_estate',       'Nemovitosti',            'anti_target', ARRAY['68'],                                0, 'migration_061'),
  ('finance',           'Finance + bankovnictví', 'anti_target', ARRAY['64','65','66'],                      0, 'migration_061'),
  ('it',                'IT a software',          'anti_target', ARRAY['62','63'],                           0, 'migration_061'),
  ('professional',      'Profesní služby',        'anti_target', ARRAY['69','70','71','72','73','74','75'],  0, 'migration_061'),
  ('health',            'Zdravotnictví',          'anti_target', ARRAY['86','87','88'],                      0, 'migration_061'),
  ('education',         'Vzdělávání',             'anti_target', ARRAY['85'],                                0, 'migration_061'),
  ('personal_services', 'Osobní služby',          'anti_target', ARRAY[]::TEXT[],                           0, 'migration_061'),
  ('adult',             'Erotika a adult',        'anti_target', ARRAY[]::TEXT[],                           0, 'migration_061'),
  ('tourism',           'Cestovní ruch',          'anti_target', ARRAY[]::TEXT[],                           0, 'migration_061')
ON CONFLICT (code, kind) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES
  ('061_icp_sectors')
ON CONFLICT (version) DO NOTHING;

COMMIT;
