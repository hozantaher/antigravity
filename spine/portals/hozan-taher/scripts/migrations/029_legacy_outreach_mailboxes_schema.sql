-- ════════════════════════════════════════════════════════════════════════
-- 029 — outreach_mailboxes legacy schema import (AW2-2)
-- ════════════════════════════════════════════════════════════════════════
--
-- Documentation re-import. See 028_legacy_companies_schema.sql for the
-- rationale: the original CREATE TABLE for outreach_mailboxes lives in
-- PROD only; this migration backfills the column list into the
-- migration corpus so the AW2 static audit can resolve references.
-- 39 columns derived from production code references, no speculation.
--
-- Idempotent: every column uses ADD COLUMN IF NOT EXISTS. PROD already
-- has these columns with their canonical types; the conservative TEXT
-- placeholders here are skipped on PROD (PostgreSQL's IF NOT EXISTS
-- check is name-only).

BEGIN;

CREATE TABLE IF NOT EXISTS outreach_mailboxes (
    id BIGSERIAL PRIMARY KEY
);

ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS address                 TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS auth_fail_at            TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS auth_fail_count         INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS auth_locked_by_observer TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS auth_locked_reason      TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS canary_remaining        INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS circuit_opened_at       TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS circuit_trip_count      INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS consecutive_bounces     INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS created_at              TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS daily_cap_override      INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS daily_cap_reduced_at    TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS email                   TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS from_address            TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_host               TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_port               INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_username           TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS last_canary_send        TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS last_score              DOUBLE PRECISION;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS last_score_at           TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS last_send_at            TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS locale                  TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS password                TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS persona_slug            TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS pinned_endpoint_at      TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS pinned_endpoint_by      TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS proxy_url               TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS released_at             TIMESTAMPTZ;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS retired_candidate       BOOLEAN;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_host               TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_port               INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_user               TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_username           TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS status                  TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS status_reason           TEXT;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS total_bounced           INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS total_sent              INTEGER;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('029_legacy_outreach_mailboxes_schema') ON CONFLICT DO NOTHING;
COMMIT;
