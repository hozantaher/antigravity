-- ════════════════════════════════════════════════════════════════════════
-- BF-G3 — schema_migrations bookkeeping table
-- ════════════════════════════════════════════════════════════════════════
--
-- Recorded by scripts/migrations/run.sh after each successful application.
-- Run.sh refuses to apply a numbered migration when its predecessor is
-- absent from this table — guards against operators applying 003 before
-- 001 (which broke us once when the pgcrypto KEK column wasn't set up
-- before the populate step).
--
-- This migration is itself migration 000 (lowest), bootstraps the table.
-- Idempotent — re-runs are safe.

CREATE TABLE IF NOT EXISTS schema_migrations (
    id              SERIAL PRIMARY KEY,
    -- 3-digit numeric prefix (string for safety; we don't compute on it).
    migration_id    TEXT NOT NULL UNIQUE,
    -- Original filename (e.g. "001_drop_campaign_enrollments.sql"), for traceability.
    filename        TEXT NOT NULL,
    -- SHA-256 of the file content at apply time. If someone edits a
    -- previously-applied migration, this lets us detect the drift.
    content_sha256  TEXT NOT NULL,
    applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by      TEXT,
    -- For audit log linking. Filled by run.sh from the runtime env.
    git_sha         TEXT
);

-- Backfill any pre-bookkeeping migrations the operator already applied.
-- Idempotent inserts (UNIQUE on migration_id). Operator can manually
-- INSERT old rows before running run.sh so existing deployments don't
-- get blocked by "001 missing".
--
-- Example backfill (run by operator on existing deployments):
--   INSERT INTO schema_migrations(migration_id, filename, content_sha256, applied_by)
--     VALUES ('001', '001_drop_campaign_enrollments.sql', 'manual-backfill', 'ops')
--     ON CONFLICT (migration_id) DO NOTHING;

COMMENT ON TABLE schema_migrations IS
'BF-G3 — bookkeeping for scripts/migrations/run.sh. Refuse-out-of-order guard.';
