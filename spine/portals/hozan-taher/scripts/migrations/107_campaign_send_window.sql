-- C3: Per-campaign send window (start/end time, nullable = use operator_settings default)
-- Before: send window via env SEND_WINDOW_START/END only (global)
-- After: per-campaign override via UI + audit log on change

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS send_window_start TIME NULL,
  ADD COLUMN IF NOT EXISTS send_window_end TIME NULL;

-- Seed schema_migrations record (canonical shape: version + migration_id + filename + applied_by)
-- Audit finding 2026-05-14 (Issue #1299): original INSERT referenced non-existent columns
-- (description, installed_on, execution_time_ms). Real schema_migrations columns:
-- id, migration_id, filename, content_sha256, applied_at, applied_by, git_sha, version.
INSERT INTO schema_migrations (version, migration_id, filename, applied_by)
VALUES ('107_campaign_send_window', '107_campaign_send_window', '107_campaign_send_window.sql', 'migration_runner')
ON CONFLICT (version) DO NOTHING;

COMMIT;
