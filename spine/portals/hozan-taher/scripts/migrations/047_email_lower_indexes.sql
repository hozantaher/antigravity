-- target: outreach-db only
-- 047_email_lower_indexes.sql — performance indexes for hot suppression + enrollment paths
-- Applied: 2026-05-02 03:18Z (CONCURRENTLY, non-blocking)
-- Predecessor: 046_manual_reply_outbox

-- Audit finding: indexing.md flagged 9M+ seq_scans on suppression_list (17 rows!)
-- because every read uses WHERE lower(trim(email)) but PK is on raw email.
-- Same shape on outreach_suppressions and contacts (1.16GB / 520k rows).
--
-- These were applied via CONCURRENTLY directly (cannot run in transaction).
-- This file documents the operation for the migration audit trail; rerunning
-- via the migration runner is idempotent (IF NOT EXISTS).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_suppression_list_email_lower
  ON suppression_list (lower(trim(email)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outreach_suppressions_email_lower
  ON outreach_suppressions (lower(trim(email)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_email_lower
  ON contacts (lower(trim(email)));

-- campaign_contacts had separate partial indexes on status + next_send_at,
-- but enrollment hot-path queries WHERE campaign_id=? AND status=? ORDER BY next_send_at.
-- Composite covers the entire predicate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_contacts_enrollment
  ON campaign_contacts (campaign_id, status, next_send_at);

INSERT INTO schema_migrations (version) VALUES ('047_email_lower_indexes') ON CONFLICT DO NOTHING;
