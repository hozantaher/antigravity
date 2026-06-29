-- Migration 086: Dedicated partial index for AR8 global aggregate volume cap query
-- Sprint AR8 — check_aggregate_volume_cap() (migration 081) performs a global
-- scan over send_events WHERE status IN ('sent','queued') AND sent_at > NOW()-1h.
--
-- Existing idx_send_events_warmup_cap is (mailbox_used, sent_at) with a partial
-- WHERE clause that requires a mailbox_used filter — it cannot satisfy the global
-- query without a seq scan on large tables.
--
-- This partial index covers the AR8 query directly:
--   EXPLAIN ANALYZE SELECT * FROM check_aggregate_volume_cap(3600, 50);
--   → should use idx_send_events_aggregate (Bitmap Index Scan or Index Only Scan)

BEGIN;

CREATE INDEX IF NOT EXISTS idx_send_events_aggregate
  ON send_events (sent_at DESC)
  WHERE status IN ('sent', 'queued');

INSERT INTO schema_migrations (version)
  VALUES ('086_send_events_aggregate_idx')
  ON CONFLICT DO NOTHING;

COMMIT;
