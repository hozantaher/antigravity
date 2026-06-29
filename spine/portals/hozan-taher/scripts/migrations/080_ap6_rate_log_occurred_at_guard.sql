-- 080_ap6_rate_log_occurred_at_guard.sql
--
-- P2.16: Hardening mailbox_op_rate_log — prevent future-dated records
--
-- Problem:
--   The mailbox_op_rate_log.occurred_at column accepts any TIMESTAMPTZ value,
--   including future times. A buggy or malicious client could INSERT
--   occurred_at = now() + 24h, effectively pre-blocking a mailbox.
--
-- Fix:
--   Add CHECK constraint: occurred_at <= NOW() + INTERVAL '1 minute'
--   This allows a small clock-skew tolerance (1 minute) for distributed systems
--   while preventing intentional future-dating.
--
-- Predecessor: 079_ap1_warmup_trigger_status_check.sql
--
-- Apply:
--   psql "$DATABASE_URL" -f scripts/migrations/080_ap6_rate_log_occurred_at_guard.sql

BEGIN;

ALTER TABLE mailbox_op_rate_log
  DROP CONSTRAINT IF EXISTS mailbox_op_rate_log_occurred_at_check;
ALTER TABLE mailbox_op_rate_log
  ADD CONSTRAINT mailbox_op_rate_log_occurred_at_check CHECK (
    occurred_at <= NOW() + INTERVAL '1 minute'
  );

INSERT INTO schema_migrations (version)
  VALUES ('080_ap6_rate_log_occurred_at_guard')
  ON CONFLICT DO NOTHING;

COMMIT;
