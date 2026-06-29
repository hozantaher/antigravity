-- ════════════════════════════════════════════════════════════════════════
-- 063 — segments + misc operator tables legacy import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.
-- (Slot 063 reused from a never-committed legal_documents migration; the
-- replacement here has no overlap with that earlier intent.)

BEGIN;

-- segments
CREATE TABLE IF NOT EXISTS segments (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE segments ADD COLUMN IF NOT EXISTS company_count   INTEGER;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS last_built_at   TIMESTAMPTZ;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS name            TEXT;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS query           TEXT;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ;

-- segment_health
CREATE TABLE IF NOT EXISTS segment_health (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS avg_icp_score    DOUBLE PRECISION;
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS champions        INTEGER;
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS classified_pct   DOUBLE PRECISION;
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS company_count    INTEGER;
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS email_valid_pct  DOUBLE PRECISION;
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS last_built_at    TIMESTAMPTZ;
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS name             TEXT;
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS untouched        INTEGER;
ALTER TABLE segment_health ADD COLUMN IF NOT EXISTS warm_ghosts      INTEGER;

-- segment_memberships
CREATE TABLE IF NOT EXISTS segment_memberships (
    company_id BIGINT,
    segment_id BIGINT
);

-- outreach_config
CREATE TABLE IF NOT EXISTS outreach_config (
    key TEXT PRIMARY KEY
);
ALTER TABLE outreach_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE outreach_config ADD COLUMN IF NOT EXISTS value      TEXT;

-- outreach_suppressions
CREATE TABLE IF NOT EXISTS outreach_suppressions (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE outreach_suppressions ADD COLUMN IF NOT EXISTS domain          TEXT;
ALTER TABLE outreach_suppressions ADD COLUMN IF NOT EXISTS email           TEXT;
ALTER TABLE outreach_suppressions ADD COLUMN IF NOT EXISTS reason          TEXT;
ALTER TABLE outreach_suppressions ADD COLUMN IF NOT EXISTS source_event_id BIGINT;

-- outreach_honeypot_signals
CREATE TABLE IF NOT EXISTS outreach_honeypot_signals (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE outreach_honeypot_signals ADD COLUMN IF NOT EXISTS contact_id  BIGINT;
ALTER TABLE outreach_honeypot_signals ADD COLUMN IF NOT EXISTS details     JSONB;
ALTER TABLE outreach_honeypot_signals ADD COLUMN IF NOT EXISTS severity    TEXT;
ALTER TABLE outreach_honeypot_signals ADD COLUMN IF NOT EXISTS signal_type TEXT;

-- suppression_list
CREATE TABLE IF NOT EXISTS suppression_list (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS campaign_id      BIGINT;
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS contact_id       BIGINT;
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ;
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS email            TEXT;
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS expires_at       TIMESTAMPTZ;
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS mailbox_id       BIGINT;
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS reason           TEXT;
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS source           TEXT;
ALTER TABLE suppression_list ADD COLUMN IF NOT EXISTS suppression_type TEXT;

-- category_suppressions
CREATE TABLE IF NOT EXISTS category_suppressions (
    category_path TEXT PRIMARY KEY
);
ALTER TABLE category_suppressions ADD COLUMN IF NOT EXISTS email  TEXT;
ALTER TABLE category_suppressions ADD COLUMN IF NOT EXISTS reason TEXT;

-- sync_checkpoints
CREATE TABLE IF NOT EXISTS sync_checkpoints (
    source TEXT PRIMARY KEY
);
ALTER TABLE sync_checkpoints ADD COLUMN IF NOT EXISTS last_run_at      TIMESTAMPTZ;
ALTER TABLE sync_checkpoints ADD COLUMN IF NOT EXISTS last_source_id   TEXT;
ALTER TABLE sync_checkpoints ADD COLUMN IF NOT EXISTS records_synced   INTEGER;
ALTER TABLE sync_checkpoints ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('063_legacy_segments_and_misc') ON CONFLICT DO NOTHING;
COMMIT;
