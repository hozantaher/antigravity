-- 060_operator_settings.sql
--
-- Creates operator_settings KV table for runtime-configurable controller
-- entity metadata, legal citations, and brand labels.
--
-- Context (Sprint AF — Operator Config Extraction):
--   Hardcoded values for BALKAN MOTORS INT DOO, PIB, Podgorica, garaaage.cz
--   are extracted from Go/JS code into this table so the operator can update
--   them via the dashboard UI or SQL UPDATE within 60 seconds (TTL-cached
--   loader in services/common/operatorconfig).
--
-- Predecessor: 059_tracking_events_event_type_idx.sql (CONCURRENTLY — applied manually)
--
-- Apply with:
--   psql "$DATABASE_URL" -f scripts/migrations/060_operator_settings.sql
-- Or via migration runner (wraps in BEGIN/COMMIT):
--   scripts/migrations/run.sh --apply 060

BEGIN;

CREATE TABLE IF NOT EXISTS operator_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator_settings_updated
  ON operator_settings (updated_at DESC);

INSERT INTO operator_settings (key, value, updated_by) VALUES
  ('controller_name',            'BALKAN MOTORS INT DOO',                          'migration_060'),
  ('controller_id_label',        'PIB',                                             'migration_060'),
  ('controller_id_value',        '03387194',                                        'migration_060'),
  ('controller_seat_address',    'Oktobarske revolucije 130, 81000 Podgorica, Crna Gora', 'migration_060'),
  ('controller_legal_basis_citation', 'čl. 6(1)(f) GDPR ve spojení s Recital 47', 'migration_060'),
  ('unsubscribe_base_url',       'https://garaaage.cz',                             'migration_060'),
  ('privacy_contact_email',      'privacy@garaaage.cz',                             'migration_060'),
  ('data_source_label',          'firmy.cz',                                        'migration_060'),
  ('brand_label',                'Garaaage',                                        'migration_060')
ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES
  ('060_operator_settings')
ON CONFLICT (version) DO NOTHING;

COMMIT;
