-- ════════════════════════════════════════════════════════════════════════
-- 179 — Raise production daily cap 100 → 140 (operator request 2026-06-26)
-- ════════════════════════════════════════════════════════════════════════
--
-- Operator wants 140 sends/mailbox/day. daily_cap_override CANNOT do this:
-- compute_daily_cap only honours an override that is STRICTLY LOWER than the
-- phase cap (migration 071) — an override >= phase_cap is ignored. So 140 is
-- only reachable by raising the production phase cap itself.
--
-- This migration:
--   (a) compute_phase_cap('production') 100 → 140 (warmup phases unchanged —
--       new mailboxes still ramp d0→d3→d7→d14 then hit the new 140 ceiling).
--   (b) Clears daily_cap_override on production mailboxes whose override is a
--       now-redundant sub-140 value (the seeded 100s + .75's 240 stays 140
--       anyway). Without this, those mailboxes keep their override (100 < 140 →
--       honoured) and never reach 140. Only clears overrides on production rows
--       that are < 140; any genuine stricter (<140) limit an operator set would
--       be cleared too — acceptable, the operator explicitly asked for 140/all.
--
-- Propagation: both enforcement points read compute_daily_cap(phase, override):
--   • DB trigger trg_enforce_warmup_cap (hard cap on send_events INSERT)
--   • Go engine newDailyCapFunc oracle (orchestrator/cmd/outreach/main.go:3585)
-- so 140 takes effect immediately, no redeploy.
--
-- Idempotent / re-run safe: CREATE OR REPLACE; UPDATE only touches sub-140
-- production overrides (re-run is a no-op once cleared).
--
-- Schema verified 2026-06-26: outreach_mailboxes(lifecycle_phase TEXT,
-- daily_cap_override INT); compute_phase_cap / compute_daily_cap from mig 071.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- (a) production phase cap 100 → 140
CREATE OR REPLACE FUNCTION compute_phase_cap(phase TEXT) RETURNS INT AS $$
BEGIN
  RETURN CASE phase
    WHEN 'warmup_d0'  THEN 5
    WHEN 'warmup_d3'  THEN 10
    WHEN 'warmup_d7'  THEN 25
    WHEN 'warmup_d14' THEN 50
    WHEN 'production' THEN 140
    ELSE 5  -- safe default for unknown phases
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- (b) clear sub-140 production overrides so the 140 phase cap governs
UPDATE outreach_mailboxes
   SET daily_cap_override = NULL, updated_at = now()
 WHERE lifecycle_phase = 'production'
   AND daily_cap_override IS NOT NULL
   AND daily_cap_override < 140;

-- audit (entity_id BIGINT → NULL for a fleet-wide change)
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'mailbox_production_cap_raised',
  'operator_request',
  'outreach_mailboxes',
  NULL,
  jsonb_build_object(
    'migration', '179_production_cap_140.sql',
    'change', 'compute_phase_cap(production) 100 -> 140; cleared sub-140 daily_cap_override on production mailboxes',
    'reason', 'operator: set 140 sends/mailbox/day'
  )
);

COMMIT;

-- ── Verify (feedback_verify_select_after_migration) ──────────────────────
\echo '── production cap function now returns 140 ──'
SELECT compute_phase_cap('production') AS production_cap, compute_phase_cap('warmup_d14') AS d14_unchanged;

\echo '── effective per-mailbox cap (production fleet) — expect 140 each ──'
SELECT from_address, lifecycle_phase, daily_cap_override,
       compute_daily_cap(lifecycle_phase, daily_cap_override) AS effective_cap
FROM outreach_mailboxes
WHERE lifecycle_phase = 'production'
ORDER BY from_address;
