-- 058_send_events_campaign_status_idx.sql
--
-- Adds composite index on send_events (campaign_id, status, sent_at DESC).
--
-- Context (Sprint AD batch 2 — post-launch hardening):
--   The daemon scheduler hot-path query is:
--     SELECT ... FROM send_events WHERE campaign_id=$1 AND status=$2 ...
--   With the existing idx_events_contact (contact_id, sent_at DESC) and
--   idx_events_queued (partial on status='queued') the planner falls back
--   to a sequential scan once row count exceeds ~1k.  This composite index
--   covers both the equality filters and the common ORDER BY sent_at DESC.
--
-- Predecessor: 057_outreach_mailboxes_sender_profile.sql
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- Apply with:
--   psql "$DATABASE_URL" -f scripts/migrations/058_send_events_campaign_status_idx.sql
-- Do NOT run via scripts/migrations/run.sh (which wraps in BEGIN/COMMIT).
-- Register manually in schema_migrations after applying (see below).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_send_events_campaign_status
  ON send_events (campaign_id, status, sent_at DESC);

INSERT INTO schema_migrations (version) VALUES ('058_send_events_campaign_status_idx') ON CONFLICT DO NOTHING;
