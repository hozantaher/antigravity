-- ════════════════════════════════════════════════════════════════════════
-- 045 — mailbox circuit/warmup/cooldown legacy import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

-- mailbox_warmup
CREATE TABLE IF NOT EXISTS mailbox_warmup (
    mailbox_address TEXT PRIMARY KEY
);
ALTER TABLE mailbox_warmup ADD COLUMN IF NOT EXISTS is_paused        BOOLEAN;
ALTER TABLE mailbox_warmup ADD COLUMN IF NOT EXISTS last_advanced_at TIMESTAMPTZ;
ALTER TABLE mailbox_warmup ADD COLUMN IF NOT EXISTS pause_reason     TEXT;
ALTER TABLE mailbox_warmup ADD COLUMN IF NOT EXISTS plan_name        TEXT;
ALTER TABLE mailbox_warmup ADD COLUMN IF NOT EXISTS warmup_day       INTEGER;

-- mailbox_check_cache
CREATE TABLE IF NOT EXISTS mailbox_check_cache (
    mailbox_id BIGINT PRIMARY KEY
);
ALTER TABLE mailbox_check_cache ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
ALTER TABLE mailbox_check_cache ADD COLUMN IF NOT EXISTS checks     JSONB;
ALTER TABLE mailbox_check_cache ADD COLUMN IF NOT EXISTS critical   INTEGER;
ALTER TABLE mailbox_check_cache ADD COLUMN IF NOT EXISTS ok         BOOLEAN;
ALTER TABLE mailbox_check_cache ADD COLUMN IF NOT EXISTS score      DOUBLE PRECISION;
ALTER TABLE mailbox_check_cache ADD COLUMN IF NOT EXISTS warnings   INTEGER;

-- mailbox_check_history
CREATE TABLE IF NOT EXISTS mailbox_check_history (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE mailbox_check_history ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
ALTER TABLE mailbox_check_history ADD COLUMN IF NOT EXISTS mailbox_id BIGINT;
ALTER TABLE mailbox_check_history ADD COLUMN IF NOT EXISTS ok         BOOLEAN;
ALTER TABLE mailbox_check_history ADD COLUMN IF NOT EXISTS score      DOUBLE PRECISION;
ALTER TABLE mailbox_check_history ADD COLUMN IF NOT EXISTS smtp_ok    BOOLEAN;

-- mailbox_cooldown_log
CREATE TABLE IF NOT EXISTS mailbox_cooldown_log (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE mailbox_cooldown_log ADD COLUMN IF NOT EXISTS bounces_at_entry     INTEGER;
ALTER TABLE mailbox_cooldown_log ADD COLUMN IF NOT EXISTS entered_at           TIMESTAMPTZ;
ALTER TABLE mailbox_cooldown_log ADD COLUMN IF NOT EXISTS left_at              TIMESTAMPTZ;
ALTER TABLE mailbox_cooldown_log ADD COLUMN IF NOT EXISTS mailbox_id           BIGINT;
ALTER TABLE mailbox_cooldown_log ADD COLUMN IF NOT EXISTS release_reason       TEXT;
ALTER TABLE mailbox_cooldown_log ADD COLUMN IF NOT EXISTS release_window_hours INTEGER;
ALTER TABLE mailbox_cooldown_log ADD COLUMN IF NOT EXISTS sent_7d_at_entry     INTEGER;

-- mailbox_imap_circuit
CREATE TABLE IF NOT EXISTS mailbox_imap_circuit (
    mailbox_id BIGINT PRIMARY KEY
);
ALTER TABLE mailbox_imap_circuit ADD COLUMN IF NOT EXISTS fail_count  INTEGER;
ALTER TABLE mailbox_imap_circuit ADD COLUMN IF NOT EXISTS open_until  TIMESTAMPTZ;
ALTER TABLE mailbox_imap_circuit ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ;

-- mailbox_pipeline_results
CREATE TABLE IF NOT EXISTS mailbox_pipeline_results (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE mailbox_pipeline_results ADD COLUMN IF NOT EXISTS mailbox_id BIGINT;
ALTER TABLE mailbox_pipeline_results ADD COLUMN IF NOT EXISTS overall_ok BOOLEAN;
ALTER TABLE mailbox_pipeline_results ADD COLUMN IF NOT EXISTS steps      JSONB;
ALTER TABLE mailbox_pipeline_results ADD COLUMN IF NOT EXISTS tested_at  TIMESTAMPTZ;

-- proxy_blacklist
CREATE TABLE IF NOT EXISTS proxy_blacklist (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE proxy_blacklist ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE proxy_blacklist ADD COLUMN IF NOT EXISTS mailbox_id BIGINT;
ALTER TABLE proxy_blacklist ADD COLUMN IF NOT EXISTS proxy_addr TEXT;
ALTER TABLE proxy_blacklist ADD COLUMN IF NOT EXISTS reason     TEXT;

-- detect_mailbox_egress_chaos
CREATE TABLE IF NOT EXISTS detect_mailbox_egress_chaos (
    mailbox_id BIGINT PRIMARY KEY
);
ALTER TABLE detect_mailbox_egress_chaos ADD COLUMN IF NOT EXISTS country_count INTEGER;
ALTER TABLE detect_mailbox_egress_chaos ADD COLUMN IF NOT EXISTS country_list  TEXT;

INSERT INTO schema_migrations (version) VALUES ('045_legacy_mailbox_circuit_warmup') ON CONFLICT DO NOTHING;
COMMIT;
