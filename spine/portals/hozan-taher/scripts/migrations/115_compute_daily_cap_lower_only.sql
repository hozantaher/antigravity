-- 115_compute_daily_cap_lower_only.sql — Sprint AG1
--
-- P0 fix: `compute_daily_cap` returned `override_val` whenever it was
-- non-NULL and > 0, **ignoring** the warmup phase cap. CLAUDE.md
-- documents the operator contract as "daily_cap_override can LOWER the
-- cap only (not raise)" — actual implementation diverged. Result:
-- mailboxes 1180-1183 (warmup_d0, phase cap 5/day) sent 130+/day each
-- since 2026-05-13 because daily_cap_override=420 overrode the 5/day
-- limit.
--
-- ## Bug reproduce (pre-fix)
--
--   SELECT compute_daily_cap('warmup_d0', 420) → 420   ❌ should be 5
--   SELECT compute_daily_cap('warmup_d0', NULL) → 5    ✓
--   SELECT compute_daily_cap('production', 420) → 420  ✓ (raises within reason)
--
-- ## Fix
--
-- Override now caps to LEAST(phase_cap, override). Operator can still
-- LOWER the cap (e.g. throttle by setting override=10 when phase_cap=100
-- in production), but cannot RAISE it past the phase ceiling.
--
-- Operator can drop the override entirely by setting it to NULL — phase
-- cap kicks in unmodified.
--
-- ## Schema verify (HARD rule feedback_schema_verify_before_sql)
--
-- \df compute_daily_cap → signature TEXT, INT → INT
-- \df compute_phase_cap → signature TEXT → INT
-- \d outreach_mailboxes → lifecycle_phase TEXT, daily_cap_override INT
-- \d send_events → mailbox_used, status, sent_at — trigger trg_enforce_warmup_cap fires here.

BEGIN;

CREATE OR REPLACE FUNCTION compute_daily_cap(phase TEXT, override_val INT)
RETURNS INT AS $$
DECLARE
  phase_cap INT;
BEGIN
  phase_cap := compute_phase_cap(phase);
  -- Override LOWERS the cap, never raises it. NULL or non-positive
  -- override = use phase cap unmodified.
  IF override_val IS NOT NULL AND override_val > 0 THEN
    RETURN LEAST(phase_cap, override_val);
  END IF;
  RETURN phase_cap;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION compute_daily_cap(TEXT, INT) IS
  'Sprint AG1: returns LEAST(phase_cap, override) — override can only LOWER. '
  'Pre-fix bug returned override unconditionally, bypassing warmup gate. '
  'Used by trg_enforce_warmup_cap on send_events INSERT.';

-- Verify post-fix
DO $$
BEGIN
  ASSERT compute_daily_cap('warmup_d0', 420) = 5,
    format('warmup_d0+420 should = 5, got %s', compute_daily_cap('warmup_d0', 420));
  ASSERT compute_daily_cap('warmup_d0', NULL) = 5,
    format('warmup_d0+NULL should = 5, got %s', compute_daily_cap('warmup_d0', NULL));
  ASSERT compute_daily_cap('production', 50) = 50,
    format('production+50 (lower) should = 50, got %s', compute_daily_cap('production', 50));
  ASSERT compute_daily_cap('production', 200) = 100,
    format('production+200 (raise) should cap to 100, got %s', compute_daily_cap('production', 200));
  RAISE NOTICE 'compute_daily_cap LEAST() semantic verified';
END;
$$;

COMMIT;
