-- 102_compute_daily_cap_bidirectional.sql
--
-- Operator decision 2026-05-12: daily_cap_override on outreach_mailboxes
-- can now RAISE the cap as well as lower it. The original Sprint AP1
-- definition (migration 071) gated override < phase_cap so the operator
-- could only de-risk a misbehaving mailbox, never push it harder than
-- the phase ceiling.
--
-- Removing the upper gate lets the operator dial individual mailboxes
-- above 100/day (production phase ceiling) without rewriting the
-- compute_phase_cap function or inventing a 'production_high' phase.
-- The mailbox lifecycle stays the same — phases still auto-advance via
-- runLifecyclePhaseAdvanceCron — but override is now authoritative.
--
-- Memory note: project_tocfg_daily_limit_zero & feedback_humanize_default_off
-- already document this dial; update CLAUDE.md / memory to reflect the
-- bidirectional semantics after this lands.

CREATE OR REPLACE FUNCTION public.compute_daily_cap(phase text, override_val integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  phase_cap INT;
BEGIN
  phase_cap := compute_phase_cap(phase);
  IF override_val IS NOT NULL AND override_val > 0 THEN
    RETURN override_val;
  END IF;
  RETURN phase_cap;
END;
$$;
