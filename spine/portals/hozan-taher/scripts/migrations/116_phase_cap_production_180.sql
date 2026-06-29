-- 116_phase_cap_production_180.sql — Sprint AG1.5
--
-- Operator directive 2026-05-15: target throughput per mailbox per day
-- is 180, not 100 (production-phase cap pre-AG). Warmup ramp scaled
-- proportionally so new mailboxes still build reputation gradually.
--
-- ## Cap table (post-fix)
--
--   warmup_d0  (Day 0-2):   5  →   10
--   warmup_d3  (Day 3-6):  10  →   30
--   warmup_d7  (Day 7-13): 25  →   70
--   warmup_d14 (Day 14-29):50  →  120
--   production (Day 30+): 100  →  180
--
-- ## Coupling with AG1 (migration 115)
--
-- migration 115 made compute_daily_cap = LEAST(phase_cap, override). So
-- with phase_cap=180 (production) and override=420, effective cap = 180.
-- Operator can still LOWER via override (e.g. 50 = throttle during
-- incident); cannot RAISE past phase cap.
--
-- ## Schema verify
--
-- \df compute_phase_cap → returns INT, takes TEXT
-- existing trigger trg_enforce_warmup_cap uses compute_daily_cap which
-- uses this fn — single source of truth.

BEGIN;

CREATE OR REPLACE FUNCTION compute_phase_cap(phase TEXT)
RETURNS INT AS $$
BEGIN
  RETURN CASE phase
    WHEN 'warmup_d0'  THEN  10
    WHEN 'warmup_d3'  THEN  30
    WHEN 'warmup_d7'  THEN  70
    WHEN 'warmup_d14' THEN 120
    WHEN 'production' THEN 180
    ELSE 10  -- unknown phase defaults to Day 0 conservative
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION compute_phase_cap(TEXT) IS
  'Sprint AG: per-day send cap per mailbox phase. Operator target 180/mb/day in production; '
  'warmup phases scaled proportionally so new mailboxes still ramp (d0=10, d3=30, d7=70, d14=120, prod=180). '
  'Trigger trg_enforce_warmup_cap on send_events INSERT uses this via compute_daily_cap.';

-- Verify
DO $$
BEGIN
  ASSERT compute_phase_cap('warmup_d0')  =  10, 'warmup_d0 expected 10';
  ASSERT compute_phase_cap('warmup_d3')  =  30, 'warmup_d3 expected 30';
  ASSERT compute_phase_cap('warmup_d7')  =  70, 'warmup_d7 expected 70';
  ASSERT compute_phase_cap('warmup_d14') = 120, 'warmup_d14 expected 120';
  ASSERT compute_phase_cap('production') = 180, 'production expected 180';
  ASSERT compute_daily_cap('production', 420) = 180, 'production+420 should cap to 180';
  ASSERT compute_daily_cap('warmup_d0', 420)  =  10, 'warmup_d0+420 should cap to 10';
  RAISE NOTICE 'compute_phase_cap operator-180 schedule verified';
END;
$$;

COMMIT;
