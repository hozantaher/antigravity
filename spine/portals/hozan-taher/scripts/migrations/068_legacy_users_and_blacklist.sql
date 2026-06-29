-- ════════════════════════════════════════════════════════════════════════
-- 068 — users + blacklist + bounce_events legacy import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
-- Documentation re-import. See 028_legacy_companies_schema.sql.

BEGIN;

-- users
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role          TEXT;

-- blacklist
CREATE TABLE IF NOT EXISTS blacklist (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS email           TEXT;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS reason          TEXT;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS source_event_id BIGINT;

-- bounce_events
CREATE TABLE IF NOT EXISTS bounce_events (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE bounce_events ADD COLUMN IF NOT EXISTS bounce_code   TEXT;
ALTER TABLE bounce_events ADD COLUMN IF NOT EXISTS bounce_reason TEXT;
ALTER TABLE bounce_events ADD COLUMN IF NOT EXISTS bounce_type   TEXT;
ALTER TABLE bounce_events ADD COLUMN IF NOT EXISTS contact_id    BIGINT;
ALTER TABLE bounce_events ADD COLUMN IF NOT EXISTS raw_message   TEXT;
ALTER TABLE bounce_events ADD COLUMN IF NOT EXISTS send_event_id BIGINT;

-- tracking_events
CREATE TABLE IF NOT EXISTS tracking_events (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE tracking_events ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ;
ALTER TABLE tracking_events ADD COLUMN IF NOT EXISTS event_type    TEXT;
ALTER TABLE tracking_events ADD COLUMN IF NOT EXISTS ip_address    TEXT;
ALTER TABLE tracking_events ADD COLUMN IF NOT EXISTS send_event_id BIGINT;
ALTER TABLE tracking_events ADD COLUMN IF NOT EXISTS user_agent    TEXT;

-- feature_flags
CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY
);
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS enabled     BOOLEAN;

-- personas
CREATE TABLE IF NOT EXISTS personas (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE personas ADD COLUMN IF NOT EXISTS active  BOOLEAN;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS bio     TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS mailbox TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS name    TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS region  TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS role    TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS tone    TEXT;

-- templates
CREATE TABLE IF NOT EXISTS templates (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS body    TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS subject TEXT;

-- operator_practice_seed_log
CREATE TABLE IF NOT EXISTS operator_practice_seed_log (
    id BIGSERIAL PRIMARY KEY
);
ALTER TABLE operator_practice_seed_log ADD COLUMN IF NOT EXISTS batch_id    TEXT;
ALTER TABLE operator_practice_seed_log ADD COLUMN IF NOT EXISTS category    TEXT;
ALTER TABLE operator_practice_seed_log ADD COLUMN IF NOT EXISTS lab_mailbox TEXT;
ALTER TABLE operator_practice_seed_log ADD COLUMN IF NOT EXISTS message_id  TEXT;

INSERT INTO schema_migrations (version) VALUES ('068_legacy_users_and_blacklist') ON CONFLICT DO NOTHING;
COMMIT;
