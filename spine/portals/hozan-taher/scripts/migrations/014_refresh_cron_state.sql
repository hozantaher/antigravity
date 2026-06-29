-- ════════════════════════════════════════════════════════════════════════
-- KT-A10 — refresh_cron_state: per-source backoff state
-- ════════════════════════════════════════════════════════════════════════
--
-- Per design doc docs/initiatives/2026-04-30-kt-a10-refresh-cron-tuning-design.md.
--
-- The refresh cron periodically pulls fresh data from public registries
-- (ARES, firmy.cz). On consecutive failures the cron applies a 1.5×
-- backoff multiplier capped at 4 hours. Without persistence, a service
-- restart would reset the multiplier to 1.0 — the next tick would slam
-- the source while it is still rate-limiting us.
--
-- This table stores per-source state. One row per registered source
-- (currently `ares`, `firmycz`). The cron reads at the start of every
-- tick and updates after fetch completion.

BEGIN;

CREATE TABLE IF NOT EXISTS refresh_cron_state (
    source                TEXT PRIMARY KEY,
    current_multiplier    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    last_run_at           TIMESTAMPTZ,
    last_status           TEXT,                       -- 'success' | 'failure' | 'skipped'
    next_run_at           TIMESTAMPTZ,                -- last_run_at + base_interval × current_multiplier
    base_interval_seconds INTEGER NOT NULL DEFAULT 3600,
    backoff_cap_seconds   INTEGER NOT NULL DEFAULT 14400,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT refresh_cron_state_multiplier_min CHECK (current_multiplier >= 1.0),
    CONSTRAINT refresh_cron_state_failures_min   CHECK (consecutive_failures >= 0),
    CONSTRAINT refresh_cron_state_status_vocab   CHECK (
        last_status IS NULL OR last_status IN ('success', 'failure', 'skipped')
    )
);

CREATE INDEX IF NOT EXISTS idx_refresh_cron_state_next_run_at
    ON refresh_cron_state (next_run_at);

COMMENT ON TABLE refresh_cron_state IS
'KT-A10: per-source backoff state for ARES + firmy.cz refresh cron. Persists across restarts.';

COMMENT ON COLUMN refresh_cron_state.current_multiplier IS
'KT-A10: 1.0 baseline; ×1.5 per consecutive failure; capped at backoff_cap_seconds / base_interval_seconds.';

COMMENT ON COLUMN refresh_cron_state.next_run_at IS
'KT-A10: computed last_run_at + (base_interval_seconds × current_multiplier) seconds.';

-- Seed rows for currently known sources. Idempotent — re-running keeps
-- existing state.
INSERT INTO refresh_cron_state (source, base_interval_seconds, backoff_cap_seconds)
VALUES
    ('ares',    3600,  14400),
    ('firmycz', 14400, 14400)
ON CONFLICT (source) DO NOTHING;

-- ── Audit log ────────────────────────────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '014_refresh_cron_state',
    jsonb_build_object(
        'description', 'KT-A10: per-source refresh cron backoff state table',
        'idempotent', true,
        'sources_seeded', jsonb_build_array('ares', 'firmycz')
    )
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DOWN migration (manual — uncomment + run if rollback needed)
-- ════════════════════════════════════════════════════════════════════════
-- BEGIN;
-- DROP INDEX IF EXISTS idx_refresh_cron_state_next_run_at;
-- DROP TABLE IF EXISTS refresh_cron_state;
-- INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
-- VALUES (
--     'migration_reverted',
--     'migration_runner',
--     'schema',
--     '014_refresh_cron_state',
--     jsonb_build_object('description', 'KT-A10: rolled back refresh_cron_state')
-- );
-- COMMIT;

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
