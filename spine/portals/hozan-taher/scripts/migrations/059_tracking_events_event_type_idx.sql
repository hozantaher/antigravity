-- 059_tracking_events_event_type_idx.sql
--
-- Adds composite index on tracking_events (event_type, created_at DESC).
--
-- Context (Sprint AD batch 2 — post-launch hardening):
--   Analytics queries filter by event_type with a date range:
--     SELECT count(*) FROM tracking_events WHERE event_type='open' AND created_at > $1
--   The existing index idx_tracking_events_send_event (send_event_id) does not
--   help these queries. Without this index the planner does a full sequential
--   scan of tracking_events for every analytics or report request.
--
-- Predecessor: 058_send_events_campaign_status_idx.sql
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- Apply with:
--   psql "$DATABASE_URL" -f scripts/migrations/059_tracking_events_event_type_idx.sql
-- Do NOT run via scripts/migrations/run.sh (which wraps in BEGIN/COMMIT).
-- Register manually in schema_migrations after applying (see below).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracking_events_event_type_created
  ON tracking_events (event_type, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('059_tracking_events_event_type_idx') ON CONFLICT DO NOTHING;
