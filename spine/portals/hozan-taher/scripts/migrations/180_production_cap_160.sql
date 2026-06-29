-- ════════════════════════════════════════════════════════════════════════
-- 180 — Raise production daily cap 140 → 160 (operator request 2026-06-26)
-- ════════════════════════════════════════════════════════════════════════
--
-- Follows 179 (100→140). compute_phase_cap('production') 140 → 160. Production
-- mailbox overrides are already NULL (cleared by 179) or >=160 (.75=240, ignored),
-- so no override change is needed — the phase cap governs and every production
-- mailbox computes 160. Both enforcement points read compute_daily_cap:
--   • DB trigger trg_enforce_warmup_cap (send_events INSERT)
--   • Go engine newDailyCapFunc oracle (orchestrator/cmd/outreach/main.go)
-- → 160 takes effect immediately, no redeploy. Warmup phases unchanged.
--
-- Reputation note: 160/mailbox/day on warmed Seznam (post.cz) production
-- mailboxes is aggressive. Dial back without a migration via daily_cap_override
-- (it can LOWER below the phase cap). Idempotent: CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION compute_phase_cap(phase TEXT) RETURNS INT AS $$
BEGIN
  RETURN CASE phase
    WHEN 'warmup_d0'  THEN 5
    WHEN 'warmup_d3'  THEN 10
    WHEN 'warmup_d7'  THEN 25
    WHEN 'warmup_d14' THEN 50
    WHEN 'production' THEN 160
    ELSE 5  -- safe default for unknown phases
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'mailbox_production_cap_raised',
  'operator_request',
  'outreach_mailboxes',
  NULL,
  jsonb_build_object(
    'migration', '180_production_cap_160.sql',
    'change', 'compute_phase_cap(production) 140 -> 160',
    'reason', 'operator: send 160/mailbox/day'
  )
);

COMMIT;

\echo '── production cap now 160; per-mailbox effective cap (expect 160 each) ──'
SELECT compute_phase_cap('production') AS production_cap;
SELECT from_address, lifecycle_phase, daily_cap_override,
       compute_daily_cap(lifecycle_phase, daily_cap_override) AS effective_cap
FROM outreach_mailboxes WHERE lifecycle_phase='production' ORDER BY from_address;
