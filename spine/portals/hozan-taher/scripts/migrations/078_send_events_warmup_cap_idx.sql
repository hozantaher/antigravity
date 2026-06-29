-- 078_send_events_warmup_cap_idx.sql
--
-- P1 performance fix: partial index for the enforce_warmup_cap() trigger query.
--
-- Problem:
--   The trg_enforce_warmup_cap trigger (migration 071) fires BEFORE INSERT on
--   send_events and runs:
--
--     SELECT count(*) FROM send_events
--      WHERE mailbox_used = NEW.mailbox_used
--        AND sent_at >= (NOW() AT TIME ZONE 'Europe/Prague')::date
--        AND status IN ('sent', 'queued');
--
--   Without a targeted index, PostgreSQL falls back to a sequential scan.
--   With 4+ mailboxes and 100k+ historic send_events rows, COUNT cost grows
--   linearly. At production cap=100/day the trigger fires on every send.
--
-- Fix:
--   Partial composite index on (mailbox_used, sent_at DESC) filtered to
--   status IN ('sent', 'queued'). The partial condition eliminates retired
--   rows ('failed', 'bounced', etc.) that can never satisfy the WHERE clause,
--   keeping the index small and the COUNT scan to today's rows only.
--
--   Target plan: Index Only Scan on idx_send_events_warmup_cap.
--
-- Predecessor: 076_ap5_mailbox_env_boundary.sql
--   (077 is reserved / skipped — no migration with that prefix exists.)
--
-- Apply:
--   psql "$DATABASE_URL" -f scripts/migrations/078_send_events_warmup_cap_idx.sql
--
-- Verify after apply:
--   EXPLAIN ANALYZE SELECT count(*) FROM send_events
--     WHERE mailbox_used = 'mb1@example.com'
--       AND sent_at >= CURRENT_DATE
--       AND status IN ('sent', 'queued');
--   → expect "Index Only Scan using idx_send_events_warmup_cap"

BEGIN;

CREATE INDEX IF NOT EXISTS idx_send_events_warmup_cap
  ON send_events (mailbox_used, sent_at DESC)
  WHERE status IN ('sent', 'queued');

INSERT INTO schema_migrations (version)
  VALUES ('078_send_events_warmup_cap_idx')
  ON CONFLICT DO NOTHING;

COMMIT;
