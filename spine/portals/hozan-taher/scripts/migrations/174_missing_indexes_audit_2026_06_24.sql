-- ════════════════════════════════════════════════════════════════════════
-- 174 — Missing indexes from the 2026-06-24 prod index audit
-- ════════════════════════════════════════════════════════════════════════
--
-- Source: full index audit against prod (junction.proxy.rlwy.net/outreach,
-- PG 16.14, 1.5 GB) on 2026-06-24. Every index below is justified by an
-- EXPLAIN (ANALYZE, BUFFERS) on live data — not a guess. The audit also
-- confirmed the agent-proposed contacts/send_events/companies/suppression
-- indexes ALREADY EXIST, so they are deliberately NOT recreated here.
--
-- NONTRANSACTIONAL: every index is built with CREATE INDEX CONCURRENTLY so the
-- build takes no ACCESS EXCLUSIVE / write-blocking lock — critical for the hot
-- tables (contacts, protection_probes are written every few seconds). The
-- non-concurrent build of an index on contacts was already shown to be
-- unobtainable under live write load (lock_timeout fired). run.sh auto-detects
-- CONCURRENTLY and applies the whole file OUTSIDE a transaction.
--
-- Re-run safety: all indexes are IF NOT EXISTS. If a CONCURRENTLY build is
-- interrupted (connection drop) it can leave an INVALID index — the verify
-- query at the bottom flags indisvalid=f; drop that one index manually
-- (DROP INDEX CONCURRENTLY <name>) and re-apply.
--
-- LEDGER: EXEMPT — non-transactional CONCURRENTLY migration; run.sh records
-- the schema_migrations row out-of-band (see run.sh NEEDS_NOTX path).
--
-- NOT included here (operator follow-ups, outside an index migration):
--   • random_page_cost is 4 (spinning-disk default) but storage is SSD →
--     planner over-prefers seq scans. Consider, separately:
--       ALTER DATABASE outreach SET random_page_cost = 1.1;
--     (The proven wins below do not depend on it — the planner already picks
--     the contacts email index at rpc=4 once it is usable.)
--   • Over-indexing: idx_contacts_eligible = 15 MB, 0 lifetime scans
--     (stats_reset=NULL → trustworthy) → drop candidate, but verify no dormant
--     campaign query needs it first. Not dropped here.
--   • pg_stat_statements is not installed (shared_preload_libraries empty);
--     enabling it (needs a restart) would give query-level visibility.
--
-- VERIFY AFTER APPLY (feedback_verify_select_after_migration): the \echo +
-- SELECT block at the end prints every new index with indisvalid + size.
-- ════════════════════════════════════════════════════════════════════════

-- ── TIER 1: tables with ZERO index usage in prod, proven full scans ──────────

-- protection_probes (478K rows, idx_scan=0). Serves BOTH hot read paths:
--   (a) WHERE layer=$1 AND level=$2 ORDER BY checked_at DESC LIMIT N
--       — was Parallel Seq Scan 478K rows / 12,857 buffers → ~10-row index scan
--   (b) SELECT DISTINCT ON (layer, level) ... ORDER BY layer, level, checked_at DESC
--       — was Seq Scan + 13 MB external merge sort to disk (407 ms)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_protection_probes_layer_level_checked
    ON protection_probes (layer, level, checked_at DESC);

-- watchdog_events (125K rows, idx_scan=0). The L2 watchdog probe runs
-- SELECT MAX(created_at) every probe cycle (seconds) — was Seq Scan 125K rows
-- (20 ms) → single-row backward index scan. Also serves the 24h health window.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_watchdog_events_created_at
    ON watchdog_events (created_at DESC);

-- watchdog_events filtered: health dashboard WHERE event_type=$1 AND created_at>...
-- (e.g. 'auth_fail_alert' ORDER BY created_at DESC LIMIT 500).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_watchdog_events_type_created
    ON watchdog_events (event_type, created_at DESC)
    WHERE event_type IS NOT NULL;

-- ── TIER 2: proven seq scans, cheap, hot paths ──────────────────────────────

-- operator_audit_log (205K rows). Retention DELETE (every 6h intelligence loop)
-- and the audit-recent display both Parallel-Seq-Scan; the existing index has
-- created_at as its 4th column (useless for `created_at <` / ORDER BY created_at).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_audit_log_created_at
    ON operator_audit_log (created_at DESC);

-- send_events: hot reply-match WHERE message_id=$1 OR rfc_message_id=$1 runs on
-- every inbound reply. rfc_message_id is indexed; message_id is NOT, so the OR
-- defeats the index and Seq-Scans. Adding this lets the planner BitmapOr both.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_send_events_message_id
    ON send_events (message_id)
    WHERE message_id IS NOT NULL;

-- ── TIER 3: unindexed foreign keys (small tables today; lock/JOIN hygiene) ────
-- An unindexed FK forces a child seq scan + lock on every parent UPDATE/DELETE.
-- Cheap insurance as these tables grow.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vehicles_contact_id
    ON vehicles (contact_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vehicles_company_id
    ON vehicles (company_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_mailbox_id
    ON leads (mailbox_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_sequence_steps_template_name
    ON outreach_sequence_steps (template_name);

-- ── HEADLINE: contacts email lookup (biggest single win) ─────────────────────
-- WHERE lower(trim(email)) = $1 currently SEQ-SCANS all 407K rows (~287 ms) on
-- EVERY call (inbound reply match + send-time suppression/dedup) — the source of
-- contacts' ~6.2M seq scans / ~1 trillion seq_tup_read. The existing UNIQUE
-- index idx_contacts_email_lower is PARTIAL (WHERE email IS NOT NULL AND
-- email <> '') and the planner cannot prove the bare query satisfies that
-- predicate, so it refuses the index. With the predicate present it is an Index
-- Scan at 0.1 ms (proven ~2600x). This non-partial functional index makes EVERY
-- call site fast with no code change.
--
-- TRADEOFF: ~10-15 MB + write overhead on the hottest/most-written table; it
-- duplicates the unique index's key data. The cleaner long-term fix is to add
-- `AND email IS NOT NULL AND email <> ''` to the lookup queries (Go
-- services/orchestrator/web/contacts_lookup.go + suppression/dedup paths; JS
-- apps/outreach-dashboard/src/server-routes/dsr.js et al.) and then
-- DROP INDEX CONCURRENTLY idx_contacts_email_lower_np. Kept here so the win
-- lands now via migration as requested.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_email_lower_np
    ON contacts (lower(trim(email)));

-- ── VERIFY ───────────────────────────────────────────────────────────────────
\echo ''
\echo '── 174 applied — new indexes (indisvalid must be t for all):'
SELECT i.indrelid::regclass AS table,
       c.relname            AS index,
       i.indisvalid         AS valid,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname IN (
    'idx_protection_probes_layer_level_checked',
    'idx_watchdog_events_created_at',
    'idx_watchdog_events_type_created',
    'idx_operator_audit_log_created_at',
    'idx_send_events_message_id',
    'idx_vehicles_contact_id',
    'idx_vehicles_company_id',
    'idx_leads_mailbox_id',
    'idx_outreach_sequence_steps_template_name',
    'idx_contacts_email_lower_np')
ORDER BY 1, 2;
