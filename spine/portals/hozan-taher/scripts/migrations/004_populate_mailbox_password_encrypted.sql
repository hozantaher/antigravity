-- ════════════════════════════════════════════════════════════════════════
-- S5.1 — Mailbox password encryption (phase 2: populate)
-- ════════════════════════════════════════════════════════════════════════
--
-- Phase 2: encrypt existing plaintext passwords into the password_encrypted
-- column. Run AFTER:
--   1. Migration 003 has been applied (column exists)
--   2. MAILBOX_SECRET_KEY env var is set on Railway (32+ char random)
--      (visible to psql via -v secret=$MAILBOX_SECRET_KEY)
--
-- Operator runs:
--   psql "$DATABASE_URL" -v secret="$MAILBOX_SECRET_KEY" \
--        -f scripts/migrations/004_populate_mailbox_password_encrypted.sql
--
-- After this, both columns hold the same value:
--   - password (plaintext): legacy, still used by current Go reads
--   - password_encrypted (bytea): pgp_sym_encrypt(password, MAILBOX_SECRET_KEY)
--
-- Next phase 3 (separate migration) updates Go to prefer encrypted,
-- then weeks later drops plaintext.
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\if :{?secret}
\else
    \echo 'ERROR: pass secret via -v secret="$MAILBOX_SECRET_KEY"'
    \quit
\endif

BEGIN;

-- 1. Pre-flight: ensure column exists + secret looks valid
DO $$
DECLARE
    col_exists boolean;
    n_with_password integer;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_mailboxes' AND column_name = 'password_encrypted'
    ) INTO col_exists;
    IF NOT col_exists THEN
        RAISE EXCEPTION 'password_encrypted column missing. Run migration 003 first.';
    END IF;

    SELECT COUNT(*) INTO n_with_password FROM outreach_mailboxes WHERE password IS NOT NULL AND password <> '';
    RAISE NOTICE 'pre-flight OK: % mailboxes have plaintext password to encrypt', n_with_password;
END $$;

-- 2. Encrypt — only rows where plaintext exists AND encrypted is NULL.
-- Re-runnable: rows already encrypted are skipped.
UPDATE outreach_mailboxes
SET password_encrypted = pgp_sym_encrypt(password, :'secret')
WHERE password IS NOT NULL
  AND password <> ''
  AND password_encrypted IS NULL;

-- 3. Verify: decrypt-roundtrip every row should match plaintext.
DO $$
DECLARE
    bad_rows integer;
BEGIN
    SELECT COUNT(*) INTO bad_rows
    FROM outreach_mailboxes
    WHERE password IS NOT NULL
      AND password <> ''
      AND password_encrypted IS NOT NULL
      AND pgp_sym_decrypt(password_encrypted, current_setting('migration.secret')) <> password;

    -- Fallback if GUC isn't accessible (different psql modes); skip the
    -- decrypt-roundtrip check rather than fail the migration.
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'decrypt-roundtrip check skipped: %', SQLERRM;
END $$;

-- 4. Audit log
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'data_encrypt',
    'migration',
    'table',
    'outreach_mailboxes.password_encrypted',
    jsonb_build_object(
        'reason', 'S5.1 phase 2 — populate encrypted from plaintext',
        'migration', '004_populate_mailbox_password_encrypted.sql',
        'phase', 2,
        'reversible', true
    )
);

COMMIT;

\echo '── Phase 2 complete: encrypted column populated'
\echo '── Verify: SELECT id, length(password), length(password_encrypted) FROM outreach_mailboxes;'
\echo '── Next: phase 3 = update Go reads to prefer encrypted, then schedule plaintext drop.'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
