-- 056_outreach_mailboxes_warmup.sql
-- Warmup tracking for new mailboxes ramping up reputation per Sprint S3.2.
-- Applied to PROD DB on 2026-05-06 (per L1 agent run).
-- File reconstructed retrospectively after agent skipped file creation.

ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS warmup_started_at timestamptz;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS warmup_day INT NOT NULL DEFAULT 0;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS warmup_target_per_day INT NOT NULL DEFAULT 100;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS warmup_active boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_outreach_mailboxes_warmup ON outreach_mailboxes(warmup_active) WHERE warmup_active = true;

INSERT INTO schema_migrations (version) VALUES ('056_outreach_mailboxes_warmup') ON CONFLICT DO NOTHING;
