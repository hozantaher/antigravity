-- ════════════════════════════════════════════════════════════════════════
-- 176 — Backfill outreach_mailboxes.total_sent + enforce NOT NULL DEFAULT 0
-- ════════════════════════════════════════════════════════════════════════
--
-- BUG (dashboard /schranky, 2026-06-25): the DELIVERY column showed 0 for the
-- hozan.taher.79–82 fleet even though they were actively sending (last_send_at
-- = today). Root-cause chain:
--   1. Migration 173 (fleet expansion) INSERTed those mailboxes WITHOUT a
--      total_sent value. The column (migration 029) has no DEFAULT, so they
--      landed as NULL.
--   2. The send path increments via `total_sent = total_sent + 1`
--      (services/mailboxes/mailbox/postgres.go TouchLastSend). In SQL,
--      NULL + 1 = NULL — so the counter never left NULL: last_send_at advanced
--      on every send but total_sent stayed NULL forever.
--   3. The dashboard MB_SELECT read raw m.total_sent (no COALESCE) → UI shows 0.
--
-- This migration:
--   • backfills the NULL counters from the authoritative send_events ledger
--     (se.mailbox_used = m.from_address), COALESCE → 0 for a mailbox with no
--     rows yet;
--   • sets DEFAULT 0 so the next fleet expansion can't repeat step 1;
--   • enforces NOT NULL so the NULL+1 trap can never recur.
--
-- Companion code fixes (same PR): postgres.go TouchLastSend now uses
-- COALESCE(total_sent,0)+1; dashboard MB_SELECT now COALESCEs total_sent.
--
-- Idempotent / re-run safe: UPDATE only touches IS NULL rows; SET DEFAULT and
-- SET NOT NULL are no-ops once applied.
--
-- LEDGER: run.sh records the schema_migrations row.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE outreach_mailboxes m
SET total_sent = COALESCE(
        (SELECT count(*)::int FROM send_events se WHERE se.mailbox_used = m.from_address),
        0)
WHERE m.total_sent IS NULL;

ALTER TABLE outreach_mailboxes ALTER COLUMN total_sent SET DEFAULT 0;
ALTER TABLE outreach_mailboxes ALTER COLUMN total_sent SET NOT NULL;

INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
    'migration_applied',
    'migration_runner',
    'schema',
    '176_backfill_total_sent_not_null',
    jsonb_build_object(
        'description', 'Backfill NULL outreach_mailboxes.total_sent from send_events; SET DEFAULT 0 + NOT NULL',
        'idempotent', true
    )
);

COMMIT;

-- ── Verify (feedback_verify_select_after_migration) ──────────────────────
-- Expect: still_null = 0, min_total_sent >= 0, and the .79–82 fleet shows
-- real lifetime counts instead of NULL/0.
SELECT
    count(*) FILTER (WHERE total_sent IS NULL) AS still_null,
    count(*)                                   AS total_mailboxes,
    min(total_sent)                            AS min_total_sent
FROM outreach_mailboxes;

SELECT from_address, total_sent, last_send_at
FROM outreach_mailboxes
WHERE from_address LIKE 'hozan.taher.%@post.cz'
ORDER BY from_address;
