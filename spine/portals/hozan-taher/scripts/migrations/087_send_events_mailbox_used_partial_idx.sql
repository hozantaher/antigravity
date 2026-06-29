-- Migration 087: Covering index on send_events (mailbox_used, sent_at) for AR15 endpoint health
-- Sprint AR15 — endpointHealth cron joins:
--   mailbox_egress_observation × outreach_mailboxes × send_events
-- on se.mailbox_used = mb.from_address over a 7-day window.
--
-- Without this index the join requires a seq scan over send_events
-- filtered by sent_at + status (large range). This covering index
-- allows efficient lookup by mailbox_used with sent_at DESC ordering.
--
-- Note: a fixed-date WHERE clause is NOT used because Postgres requires
-- immutable predicates for partial indexes. A full index on
-- (mailbox_used, sent_at DESC) with status filter covers all AR15 use cases.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_send_events_mailbox_used_recent
  ON send_events (mailbox_used, sent_at DESC)
  WHERE status IN ('sent', 'queued', 'bounced', 'failed');

INSERT INTO schema_migrations (version)
  VALUES ('087_send_events_mailbox_used_partial_idx')
  ON CONFLICT DO NOTHING;

COMMIT;
