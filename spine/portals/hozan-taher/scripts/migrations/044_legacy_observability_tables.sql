-- ════════════════════════════════════════════════════════════════════════
-- 044 — observability tables legacy import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.
-- watchdog_events + healing_log + protection_alerts + protection_probes
-- + protection_trace + cron_heartbeats + mailbox_alerts + synthetic_runs
-- + endpoint_hits + anti_trace_pings + operator_audit_log

BEGIN;

-- watchdog_events
CREATE TABLE IF NOT EXISTS watchdog_events (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS auto_healed BOOLEAN;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS check_name  TEXT;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS event_type  TEXT;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS healed_at   TIMESTAMPTZ;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS mailbox_id  BIGINT;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS message     TEXT;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS metadata    JSONB;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS reason      TEXT;
ALTER TABLE watchdog_events ADD COLUMN IF NOT EXISTS severity    TEXT;

-- healing_log
CREATE TABLE IF NOT EXISTS healing_log (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS action             TEXT;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS block_type         TEXT;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS body_signature     TEXT;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS entity_id          BIGINT;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS entity_label       TEXT;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS entity_type        TEXT;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS fallback_attempted BOOLEAN;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS http_status        INTEGER;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS occurred_at        TIMESTAMPTZ;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS reason             TEXT;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS recovered          BOOLEAN;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS resolved_at        TIMESTAMPTZ;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS source_name        TEXT;
ALTER TABLE healing_log ADD COLUMN IF NOT EXISTS target_url         TEXT;

-- protection_alerts
CREATE TABLE IF NOT EXISTS protection_alerts (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS acked_at             TIMESTAMPTZ;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS detail               TEXT;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS fired_at             TIMESTAMPTZ;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS last_status          TEXT;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS layer                TEXT;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS level                INTEGER;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS resolved_at          TIMESTAMPTZ;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS severity             TEXT;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS status               TEXT;
ALTER TABLE protection_alerts ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ;

-- protection_probes
CREATE TABLE IF NOT EXISTS protection_probes (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE protection_probes ADD COLUMN IF NOT EXISTS actual     TEXT;
ALTER TABLE protection_probes ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
ALTER TABLE protection_probes ADD COLUMN IF NOT EXISTS detail     TEXT;
ALTER TABLE protection_probes ADD COLUMN IF NOT EXISTS expected   TEXT;
ALTER TABLE protection_probes ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
ALTER TABLE protection_probes ADD COLUMN IF NOT EXISTS layer      TEXT;
ALTER TABLE protection_probes ADD COLUMN IF NOT EXISTS level      INTEGER;
ALTER TABLE protection_probes ADD COLUMN IF NOT EXISTS status     TEXT;

-- protection_trace
CREATE TABLE IF NOT EXISTS protection_trace (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE protection_trace ADD COLUMN IF NOT EXISTS layers     JSONB;
ALTER TABLE protection_trace ADD COLUMN IF NOT EXISTS message_id TEXT;

-- cron_heartbeats
CREATE TABLE IF NOT EXISTS cron_heartbeats (
    cron_name TEXT PRIMARY KEY
);
ALTER TABLE cron_heartbeats ADD COLUMN IF NOT EXISTS last_duration_ms INTEGER;
ALTER TABLE cron_heartbeats ADD COLUMN IF NOT EXISTS last_error       TEXT;
ALTER TABLE cron_heartbeats ADD COLUMN IF NOT EXISTS last_run_at      TIMESTAMPTZ;
ALTER TABLE cron_heartbeats ADD COLUMN IF NOT EXISTS last_status      TEXT;

-- mailbox_alerts
CREATE TABLE IF NOT EXISTS mailbox_alerts (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE mailbox_alerts ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ;
ALTER TABLE mailbox_alerts ADD COLUMN IF NOT EXISTS mailbox_id  BIGINT;
ALTER TABLE mailbox_alerts ADD COLUMN IF NOT EXISTS message     TEXT;
ALTER TABLE mailbox_alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE mailbox_alerts ADD COLUMN IF NOT EXISTS severity    TEXT;
ALTER TABLE mailbox_alerts ADD COLUMN IF NOT EXISTS type        TEXT;

-- synthetic_runs
CREATE TABLE IF NOT EXISTS synthetic_runs (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE synthetic_runs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE synthetic_runs ADD COLUMN IF NOT EXISTS fail_count  INTEGER;
ALTER TABLE synthetic_runs ADD COLUMN IF NOT EXISTS pass_count  INTEGER;
ALTER TABLE synthetic_runs ADD COLUMN IF NOT EXISTS ran_at      TIMESTAMPTZ;
ALTER TABLE synthetic_runs ADD COLUMN IF NOT EXISTS results     JSONB;
ALTER TABLE synthetic_runs ADD COLUMN IF NOT EXISTS suite       TEXT;

-- endpoint_hits
CREATE TABLE IF NOT EXISTS endpoint_hits (
    route TEXT
);
ALTER TABLE endpoint_hits ADD COLUMN IF NOT EXISTS hits          INTEGER;
ALTER TABLE endpoint_hits ADD COLUMN IF NOT EXISTS window_start  TIMESTAMPTZ;

-- anti_trace_pings
CREATE TABLE IF NOT EXISTS anti_trace_pings (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE anti_trace_pings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- operator_audit_log
CREATE TABLE IF NOT EXISTS operator_audit_log (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE operator_audit_log ADD COLUMN IF NOT EXISTS action      TEXT;
ALTER TABLE operator_audit_log ADD COLUMN IF NOT EXISTS actor       TEXT;
ALTER TABLE operator_audit_log ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ;
ALTER TABLE operator_audit_log ADD COLUMN IF NOT EXISTS details     JSONB;
ALTER TABLE operator_audit_log ADD COLUMN IF NOT EXISTS entity_id   BIGINT;
ALTER TABLE operator_audit_log ADD COLUMN IF NOT EXISTS entity_type TEXT;

INSERT INTO schema_migrations (version) VALUES ('044_legacy_observability_tables') ON CONFLICT DO NOTHING;
COMMIT;
