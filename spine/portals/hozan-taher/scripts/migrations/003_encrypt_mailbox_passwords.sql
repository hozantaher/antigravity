-- ════════════════════════════════════════════════════════════════════════
-- S5.1 — Mailbox password encryption (backward-compat phase 1)
-- ════════════════════════════════════════════════════════════════════════
--
-- Phase 1 ONLY: add `password_encrypted` bytea column alongside existing
-- plaintext `password` column. Does NOT drop plaintext yet — needs ops
-- verification first.
--
-- After this migration:
--   - password_encrypted is NULL on all rows
--   - All read paths still resolve from `password` (plaintext) — backward compatible
--
-- Phase 2 (separate migration, after operator verifies):
--   - Populate password_encrypted = pgp_sym_encrypt(password, $secret)
--   - Update Go `mailboxColumns` to prefer encrypted, fallback plaintext
--   - Verify sends still work
--
-- Phase 3 (separate migration, weeks later):
--   - DROP COLUMN password (plaintext)
--   - Mailbox creds are now only in encrypted form
--
-- Why phased: a broken decrypt at any point breaks ALL sends. Phased
-- rollout means each phase has rollback to previous state.
--
-- Operator runs:
--   psql "$DATABASE_URL" -f scripts/migrations/003_encrypt_mailbox_passwords.sql
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 1. Ensure pgcrypto is available
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Add encrypted column (backward-compat: nullable, no default).
ALTER TABLE outreach_mailboxes
    ADD COLUMN IF NOT EXISTS password_encrypted bytea;

-- 3. Add comment explaining the lifecycle for future operators / engineers.
COMMENT ON COLUMN outreach_mailboxes.password_encrypted IS
    'Encrypted mailbox password (pgp_sym_encrypt with MAILBOX_SECRET_KEY env). '
    'Backward-compat: NULL means fall back to plaintext password column. '
    'Phase 2 will populate, phase 3 will drop plaintext password column. '
    'See scripts/migrations/003_encrypt_mailbox_passwords.sql + S5 in launch plan v3.';

-- 4. Audit log entry.
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'schema_add_column',
    'migration',
    'table',
    'outreach_mailboxes.password_encrypted',
    jsonb_build_object(
        'reason', 'S5.1 phase 1 — add encrypted column (no data yet)',
        'migration', '003_encrypt_mailbox_passwords.sql',
        'phase', 1,
        'reversible', true
    )
);

COMMIT;

\echo '── Phase 1 complete: password_encrypted column added (NULL on all rows)'
\echo '── Next steps:'
\echo '──   1. Set MAILBOX_SECRET_KEY env var on Railway (32+ char random)'
\echo '──   2. Run scripts/migrations/004_populate_mailbox_password_encrypted.sql'
\echo '──   3. Verify sends work via campaign send-test'
\echo '──   4. Schedule scripts/migrations/005_drop_mailbox_password_plaintext.sql'
\echo '──      after 30+ days of stable operation'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
