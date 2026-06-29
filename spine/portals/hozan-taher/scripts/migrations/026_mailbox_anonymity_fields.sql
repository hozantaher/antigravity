-- ════════════════════════════════════════════════════════════════════════
-- 026 — Mailbox anonymity fields (defensive idempotent guard)
-- ════════════════════════════════════════════════════════════════════════
--
-- Trigger: 2026-05-01 brutal anonymity test scored 17/100. Three
-- header-level leaks fixed in branch feat/anti-trace-headers-anonymity:
--
--   FIX 1 — per-recipient Message-ID HMAC (no DB change; uses
--           MESSAGE_ID_HMAC_KEY env via common/envconfig.RequireBase64Bytes)
--   FIX 2 — From: "Display Name <addr>"  → reads outreach_mailboxes.display_name
--   FIX 3 — Date: mailbox.timezone        → reads outreach_mailboxes.tz
--
-- Anti-trace MAP referenced: docs/subsystem-maps/anti-trace.md
-- (commit db402237948557f566591da8444269685f314bd4) — these headers
-- are written between G7 (humanize fingerprint) and G10 (relay submit).
--
-- The canonical CREATE TABLE for outreach_mailboxes already declares
-- display_name + tz (see services/mailboxes/mailbox/schema_invariant_test.go
-- describing migration 035). This migration is a defensive idempotent
-- guard for half-migrated environments where 035 may not have applied
-- (legacy dev DBs, Railway ephemerals, etc.). It is safe to run on a
-- schema that already has the columns — every statement uses
-- IF NOT EXISTS or DO $$ IF NOT EXISTS guards.
--
-- Operator-facing note: this migration is NOT auto-applied. Apply via
-- `scripts/migrations/run.sh 026` per docs/playbooks/migration-rollout-plan.md.

-- ── display_name ────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'outreach_mailboxes'
           AND column_name = 'display_name'
    ) THEN
        ALTER TABLE outreach_mailboxes
            ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
        COMMENT ON COLUMN outreach_mailboxes.display_name IS
            'Per-mailbox From-header display name. Empty fallback: title-cased local-part of from_address ("a.mazher" → "A. Mazher"). Source for sender/headers.go BuildFromHeader.';
    END IF;
END$$;

-- ── tz (IANA timezone) ──────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'outreach_mailboxes'
           AND column_name = 'tz'
    ) THEN
        ALTER TABLE outreach_mailboxes
            ADD COLUMN tz TEXT NOT NULL DEFAULT 'Europe/Prague';
        COMMENT ON COLUMN outreach_mailboxes.tz IS
            'IANA timezone for the Date header (RFC 5322). Defaults Europe/Prague — never UTC, which would leak the Railway US datacenter location.';
    END IF;
END$$;

-- ── Backfill empty display_name from from_address local part ────────────
-- Idempotent: only writes rows where display_name is currently empty.
-- The Go fallback (sender/headers.go titleCaseLocalPart) does the same
-- transformation at send time, but persisting it once keeps the DB
-- self-documenting and removes a per-send compute cycle.
UPDATE outreach_mailboxes
   SET display_name = INITCAP(REPLACE(REPLACE(SPLIT_PART(from_address, '@', 1), '.', ' '), '_', ' '))
 WHERE display_name = '' OR display_name IS NULL;

-- ── Audit ───────────────────────────────────────────────────────────────
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '026_mailbox_anonymity_fields',
    jsonb_build_object(
        'description', 'idempotent guard for outreach_mailboxes.display_name + tz; backfill empty display_name from local part',
        'fixes',       ARRAY['anti-trace anonymity FIX 2 (From display name)', 'anti-trace anonymity FIX 3 (Date timezone)'],
        'idempotent',  true,
        'anti_trace_map_sha', 'db402237948557f566591da8444269685f314bd4'
    )
);

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
