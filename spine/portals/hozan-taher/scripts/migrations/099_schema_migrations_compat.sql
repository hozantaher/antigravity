-- ════════════════════════════════════════════════════════════════════════
-- 099 — schema_migrations column compat migration
-- ════════════════════════════════════════════════════════════════════════
--
-- Context: Prod was bootstrapped before BF-G3 run.sh was installed. The
-- table therefore only has (version text, applied_at timestamptz). The
-- runner expects (migration_id, filename, content_sha256, applied_by,
-- git_sha) per 000_schema_migrations.sql.
--
-- This migration adds the missing columns idempotently (ADD COLUMN IF
-- NOT EXISTS), backfills migration_id from version for rows that
-- pre-date the new schema, and pins a UNIQUE constraint so the runner's
-- ON CONFLICT guard works.
--
-- Out-of-band high number (099) is intentional: it sorts last among any
-- currently-pending numbered migrations (022, 023, 024, …) and applies
-- once regardless of execution order. After 099 lands the runner has a
-- full-schema table and drift detection is re-enabled.
--
-- Idempotent: re-runs are safe.
-- ════════════════════════════════════════════════════════════════════════

-- Step 1: Add missing columns. Each is idempotent via IF NOT EXISTS.
ALTER TABLE schema_migrations
    ADD COLUMN IF NOT EXISTS migration_id   TEXT,
    ADD COLUMN IF NOT EXISTS filename       TEXT,
    ADD COLUMN IF NOT EXISTS content_sha256 TEXT,
    ADD COLUMN IF NOT EXISTS applied_by     TEXT,
    ADD COLUMN IF NOT EXISTS git_sha        TEXT;

-- Step 2: Backfill migration_id from version for pre-BF-G3 rows.
-- These rows were inserted by a simpler bookkeeping scheme that stored
-- the migration prefix in a column called "version". Copy it over so
-- the runner can read them.
UPDATE schema_migrations
    SET migration_id = version
    WHERE migration_id IS NULL
      AND version IS NOT NULL;

-- Step 3: Set a sentinel sha for rows with no content hash recorded.
-- The runner skips drift detection when content_sha256 = 'manual-backfill',
-- so this prevents false-positive exit-4 on pre-BF-G3 rows.
UPDATE schema_migrations
    SET content_sha256 = 'manual-backfill'
    WHERE content_sha256 IS NULL;

-- Step 4: Ensure filename is non-null (runner writes it; old rows have none).
UPDATE schema_migrations
    SET filename = migration_id || '.sql'
    WHERE filename IS NULL
      AND migration_id IS NOT NULL;

-- Step 5: Apply UNIQUE constraint on migration_id if not already present.
-- ON CONFLICT DO NOTHING in the runner depends on this.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'schema_migrations_migration_id_key'
          AND conrelid = 'schema_migrations'::regclass
    ) THEN
        -- Only safe when all migration_id values are already unique; if the
        -- backfill produced duplicates the operator should investigate first.
        ALTER TABLE schema_migrations
            ADD CONSTRAINT schema_migrations_migration_id_key UNIQUE (migration_id);
    END IF;
END;
$$;

COMMENT ON TABLE schema_migrations IS
'BF-G3 — bookkeeping for scripts/migrations/run.sh. Extended by 099 compat migration.';

INSERT INTO schema_migrations (version) VALUES ('099_schema_migrations_compat') ON CONFLICT DO NOTHING;
