-- Migration 081: aggregate volume cap function
-- Sprint AR8 — prevents spike sends (all mailboxes sending in burst → recipient
-- SMTP server sees aggregate spike → reputation hit).
--
-- check_aggregate_volume_cap(window_seconds, max_sends) → (sends_in_window, cap, exceeded)
-- Called by BFF campaign-send-batch.js before each batch to gate on hourly volume.
--
-- Default: 50 sends/hour across all mailboxes (conservative start; raise via
-- GLOBAL_AGGREGATE_CAP env var as reputation builds).
BEGIN;

CREATE OR REPLACE FUNCTION check_aggregate_volume_cap(
  window_seconds INT DEFAULT 3600,
  max_sends      INT DEFAULT 50
)
RETURNS TABLE(
  sends_in_window BIGINT,
  cap             INT,
  exceeded        BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    count(*)::bigint                AS sends_in_window,
    max_sends                       AS cap,
    count(*) > max_sends            AS exceeded
  FROM send_events
  WHERE sent_at > NOW() - make_interval(secs => window_seconds)
    AND status IN ('sent', 'queued');
$$;

INSERT INTO schema_migrations (version)
  VALUES ('081_aggregate_volume_cap')
  ON CONFLICT DO NOTHING;

COMMIT;
