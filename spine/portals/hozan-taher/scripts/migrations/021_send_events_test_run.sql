-- Migration 021: add test_run_id column to send_events
--
-- Adds a nullable UUID column so the anonymity-test CLI (Sprint S1) can tag
-- test-run rows for later pairing by the IMAP harvester (Sprint S2).
-- Indexed for fast lookup by test_run_id across all 36 test rows per run.
--
-- No existing rows are affected (column is nullable with no default).
-- campaign_id / contact_id FK constraints are intentionally left intact;
-- the CLI uses the dedicated INTERNAL TEST campaign for test rows.

ALTER TABLE send_events
    ADD COLUMN IF NOT EXISTS test_run_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_send_events_test_run_id
    ON send_events (test_run_id)
    WHERE test_run_id IS NOT NULL;

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
