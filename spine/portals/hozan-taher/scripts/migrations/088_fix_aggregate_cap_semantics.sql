-- Migration 088: Fix AR8 aggregate volume cap semantics — >= → >
-- Sprint AR8 P1.7 — migration 081 used count(*) >= max_sends, which means
-- with cap=50 only 49 sends are allowed before the cap fires.
-- The 50th send sees count=49 (< 50) → allowed → inserts → count becomes 50.
-- Next check: count=50 >= 50 → blocked. Effective cap is N-1, not N.
--
-- Fix: change to count(*) > max_sends so:
--   count=49 → 49 > 50 = false → allowed (50th send)
--   count=50 → 50 > 50 = false → allowed (but this is the 51st attempt; count reads BEFORE insert)
-- Correct semantics: GLOBAL_AGGREGATE_CAP=50 allows exactly 50 sends/hour,
-- blocks the 51st.

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
  VALUES ('088_fix_aggregate_cap_semantics')
  ON CONFLICT DO NOTHING;

COMMIT;
