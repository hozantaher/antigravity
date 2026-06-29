-- 121_vehicles_inventory.sql
--
-- AU-F1 (2026-05-19): vehicles inventory table — links inbound replies
-- to the actual product being negotiated (used heavy machinery).
--
-- Workflow:
--   Reply arrives in /replies → operator extracts vehicle metadata
--   → record persists here → linked to crm_clients via upsert →
--   operator tracks deal state (offered → negotiating → agreed → paid
--   → picked_up).
--
-- Schema choices:
--   - source_reply_id is BIGINT (can be negative for orphan replies
--     from unmatched_inbound, mirrors the /api/replies UNION ALL).
--   - photos JSONB array of { filename, content_type, attachment_id,
--     mime_idx } — references unmatched_inbound_attachments OR
--     message_attachments depending on the source reply.
--   - price triplet (asking/offered/agreed) captures negotiation arc.
--   - status_changed_at lets the UI show "v jednání 5 dní" rhythm
--     dividers without joining an audit table.
--
-- Predecessor: 120_replies_perf_indexes.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '120_replies_perf_indexes'
  ) THEN
    RAISE EXCEPTION 'Predecessor 120_replies_perf_indexes not applied';
  END IF;
END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS vehicles (
  id              BIGSERIAL PRIMARY KEY,

  -- Identity
  make            TEXT NOT NULL,
  model           TEXT NOT NULL,
  year            INT,
  vin             TEXT,

  -- Specs (all nullable — operator may not have full info up front)
  mileage_km      INT,
  fuel            TEXT,
  transmission    TEXT,
  body_type       TEXT,
  color           TEXT,

  -- Pricing arc — EUR
  price_asking_eur  INT,   -- operator's market estimate when capturing
  price_offered_eur INT,   -- what the seller is asking
  price_agreed_eur  INT,   -- final negotiated price

  -- Status pipeline
  status          TEXT NOT NULL DEFAULT 'offered',
  CONSTRAINT vehicles_status_check
    CHECK (status IN ('offered','negotiating','agreed','paid','picked_up','cancelled')),

  -- Provenance — where it came from
  source_reply_id     BIGINT,
  source_reply_email  TEXT,
  contact_id          BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  company_id          BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  crm_client_id       BIGINT REFERENCES crm_clients(id) ON DELETE SET NULL,

  -- Notes + photos
  notes  TEXT,
  photos JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Timestamps
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_status_created
  ON vehicles (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicles_crm_client_id
  ON vehicles (crm_client_id)
  WHERE crm_client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vehicles_source_reply_id
  ON vehicles (source_reply_id)
  WHERE source_reply_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vehicles_source_email
  ON vehicles (LOWER(source_reply_email))
  WHERE source_reply_email IS NOT NULL AND source_reply_email <> '';

-- Auto-update updated_at on row mutation. status_changed_at updated
-- only when status column actually changes (avoids touching it on
-- price-only updates).
CREATE OR REPLACE FUNCTION vehicles_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vehicles_touch_updated_at ON vehicles;
CREATE TRIGGER trg_vehicles_touch_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_touch_updated_at();

INSERT INTO schema_migrations (version)
  VALUES ('121_vehicles_inventory')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification queries (feedback_verify_select_after_migration T0):
\echo '── Table created with expected columns: ──'
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'vehicles'
 ORDER BY ordinal_position;

\echo '── Indexes on vehicles: ──'
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'vehicles'
 ORDER BY indexname;

\echo '── Status constraint enforced: ──'
SELECT pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname = 'vehicles_status_check';

\echo '── Audit log mutation (feedback_audit_log_on_mutations T0): ──'
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'schema_migration_applied',
  'migration',
  'schema_migrations',
  '121',
  jsonb_build_object(
    'migration', '121_vehicles_inventory.sql',
    'tables_created', ARRAY['vehicles'],
    'indexes_added', 4,
    'triggers_added', 1,
    'reason', 'AU-F1: vehicles inventory layer — links inbound replies to negotiated product (used heavy machinery).'
  )
);

\echo '── Migration recorded: ──'
SELECT version FROM schema_migrations WHERE version = '121_vehicles_inventory';
