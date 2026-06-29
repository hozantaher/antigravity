-- ════════════════════════════════════════════════════════════════════════
-- S6.2 — Seed multi-mailbox pool for scale-up
-- ════════════════════════════════════════════════════════════════════════
--
-- Adds 3 new Seznam mailboxes (mb=633, 634, 635) + their personas to
-- support sustained sending >50 contacts/month. Single mailbox = ~120/day
-- daily cap; pool of 5 mailboxes = ~600/day theoretical max with proper
-- warmup ramp.
--
-- Pre-flight (operator):
--   1. Register 3 new Seznam email addresses (operator-driven; Seznam
--      doesn't allow bulk creation, manual signup)
--   2. Generate 3 separate Seznam app passwords (one per mailbox)
--   3. Replace placeholders below with real addresses + display names
--   4. Run this migration
--   5. Set passwords via separate UPDATE (passwords NOT in this script —
--      they go to outreach_mailboxes.password via the dashboard or
--      direct SQL with the value)
--
-- Each new mailbox starts at:
--   - status = 'paused' (operator activates after credentials set)
--   - daily_cap_override = 30 (warmup day 3 — already past initial ramp)
--   - warmup tracking via mailbox_warmup table (separate process)
--
-- This script is idempotent — re-running won't duplicate rows
-- (ON CONFLICT DO NOTHING on from_address).
--
-- Operator runs:
--   psql "$DATABASE_URL" -f scripts/migrations/006_seed_multi_mailbox_pool.sql
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 1. Insert 3 new mailboxes. Replace [OP] placeholders with operator-supplied
-- addresses before running. Display name = "B. Maarek" preserves persona
-- consistency with mb=631/632 (same sender identity for recipients who
-- might receive multiple campaigns).
INSERT INTO outreach_mailboxes (
    from_address, display_name, persona_slug,
    smtp_host, smtp_port, smtp_username,
    imap_host, imap_port, imap_username,
    daily_cap_override, tz, locale,
    status, status_reason
)
VALUES
    ('REPLACE_633@email.cz', 'B. Maarek', 'b-maarek-3',
     'smtp.seznam.cz', 465, 'REPLACE_633@email.cz',
     'imap.seznam.cz', 993, 'REPLACE_633@email.cz',
     30, 'Europe/Prague', 'cs',
     'paused', 'multi-mailbox seed: awaiting credentials + activation'),

    ('REPLACE_634@email.cz', 'B. Maarek', 'b-maarek-4',
     'smtp.seznam.cz', 465, 'REPLACE_634@email.cz',
     'imap.seznam.cz', 993, 'REPLACE_634@email.cz',
     30, 'Europe/Prague', 'cs',
     'paused', 'multi-mailbox seed: awaiting credentials + activation'),

    ('REPLACE_635@email.cz', 'B. Maarek', 'b-maarek-5',
     'smtp.seznam.cz', 465, 'REPLACE_635@email.cz',
     'imap.seznam.cz', 993, 'REPLACE_635@email.cz',
     30, 'Europe/Prague', 'cs',
     'paused', 'multi-mailbox seed: awaiting credentials + activation')
ON CONFLICT (from_address) DO NOTHING;

-- 2. Insert personas for each (matches sign-off in templates: "B. Maarek / Garaaage")
INSERT INTO personas (mailbox, name, email, active)
SELECT from_address, display_name, from_address, false  -- inactive until credentials set
FROM outreach_mailboxes
WHERE from_address IN ('REPLACE_633@email.cz', 'REPLACE_634@email.cz', 'REPLACE_635@email.cz')
ON CONFLICT (mailbox) DO NOTHING;

-- 3. Audit log entry
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'mailbox_pool_seed',
    'migration',
    'table',
    'outreach_mailboxes',
    jsonb_build_object(
        'reason', 'S6.2 multi-mailbox seed for scale-up to >50 contacts/month',
        'migration', '006_seed_multi_mailbox_pool.sql',
        'mailboxes_added', 3,
        'reversible', true
    )
);

COMMIT;

\echo ''
\echo '── Mailbox pool seeded (3 new entries, status=paused)'
\echo '── Next steps:'
\echo '──   1. Replace REPLACE_*@email.cz with actual Seznam addresses'
\echo '──   2. UPDATE outreach_mailboxes SET password = ... WHERE id = ...'
\echo '──   3. UPDATE outreach_mailboxes SET status = ''active'' WHERE id IN (...)'
\echo '──   4. UPDATE personas SET active = true WHERE mailbox IN (...)'
\echo '──   5. Run send-test from each new mailbox to verify creds + relay'
\echo '──   6. Monitor first 24h sends for bounce / auth-fail signals'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
