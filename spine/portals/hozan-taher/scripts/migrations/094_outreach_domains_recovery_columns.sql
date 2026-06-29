-- 094_outreach_domains_recovery_columns.sql
--
-- Idempotently ensures every column that
-- `services/orchestrator/intelligence/domain.go:RecoverSuppressedDomains`
-- references exists on outreach_domains. Migration 043 already declared
-- these columns for a fresh install, but the legacy table that 043 was
-- imported into in production never carried them — RecoverSuppressedDomains
-- failed every 6h intelligence tick with
-- `pq: column d.suppressed_at does not exist (42703)` (and earlier with
-- the now-fixed se.domain reference, see PR #1223).
--
-- This file is a no-op when 043 was applied cleanly. When the prod legacy
-- import was incomplete, it backfills the missing columns so the recovery
-- loop can run without surfacing 42703 errors to Sentry.
--
-- Predecessor: 099_schema_migrations_compat.sql (numerically out of order;
-- see CLAUDE.md note — 094 is intentionally before 099 since 099 was
-- backfilled into the schema_migrations table as a compat row).

BEGIN;

ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS is_suppressed     BOOLEAN       NOT NULL DEFAULT false;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS suppressed_at     TIMESTAMPTZ;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS suppressed_reason TEXT;
ALTER TABLE outreach_domains ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now();

COMMIT;
