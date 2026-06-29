-- 071_mailbox_lifecycle_caps.sql
--
-- Sprint AP1: Warmup ramp enforced in DB.
-- Operator/agent cannot bypass warmup cap via BFF or Go runner.
-- DB trigger refuses send_events INSERT past daily_cap_effective for mailbox age.
--
-- Lifecycle phases (text with CHECK):
--   warmup_d0  → Day 0–2:  5  sends/day
--   warmup_d3  → Day 3–6:  10 sends/day
--   warmup_d7  → Day 7–13: 25 sends/day
--   warmup_d14 → Day 14–29: 50 sends/day
--   production → Day 30+:  100 sends/day
--
-- daily_cap_override: operator can SET A LOWER CAP only (not higher).
--   compute_daily_cap returns min(phase_cap, override) when override set,
--   or phase_cap when override is NULL / 0 / >= phase_cap.
--
-- Predecessor: 070_drop_dead_mailboxes.sql
--
-- Apply:
--   psql "$DATABASE_URL" -f scripts/migrations/071_mailbox_lifecycle_caps.sql

BEGIN;

-- ── 1. lifecycle_phase column ─────────────────────────────────────────────────

ALTER TABLE outreach_mailboxes
  ADD COLUMN IF NOT EXISTS lifecycle_phase TEXT NOT NULL DEFAULT 'warmup_d0';

ALTER TABLE outreach_mailboxes DROP CONSTRAINT IF EXISTS outreach_mailboxes_lifecycle_phase_check;
ALTER TABLE outreach_mailboxes
  ADD CONSTRAINT outreach_mailboxes_lifecycle_phase_check CHECK (
    lifecycle_phase IN ('warmup_d0', 'warmup_d3', 'warmup_d7', 'warmup_d14', 'production')
  );

-- Backfill existing mailboxes from their actual created_at age.
UPDATE outreach_mailboxes
   SET lifecycle_phase = CASE
     WHEN NOW() - created_at >= INTERVAL '30 days' THEN 'production'
     WHEN NOW() - created_at >= INTERVAL '14 days' THEN 'warmup_d14'
     WHEN NOW() - created_at >= INTERVAL '7 days'  THEN 'warmup_d7'
     WHEN NOW() - created_at >= INTERVAL '3 days'  THEN 'warmup_d3'
     ELSE 'warmup_d0'
   END
 WHERE status NOT IN ('retired');

-- ── 2. compute_phase_cap — pure lookup ───────────────────────────────────────

CREATE OR REPLACE FUNCTION compute_phase_cap(phase TEXT) RETURNS INT AS $$
BEGIN
  RETURN CASE phase
    WHEN 'warmup_d0'  THEN 5
    WHEN 'warmup_d3'  THEN 10
    WHEN 'warmup_d7'  THEN 25
    WHEN 'warmup_d14' THEN 50
    WHEN 'production' THEN 100
    ELSE 5  -- safe default for unknown phases
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── 3. compute_daily_cap — respects operator lower-bound override ─────────────

CREATE OR REPLACE FUNCTION compute_daily_cap(phase TEXT, override_val INT) RETURNS INT AS $$
DECLARE
  phase_cap INT;
BEGIN
  phase_cap := compute_phase_cap(phase);
  -- Operator override is only honoured when it is a stricter (lower) cap.
  -- A NULL, zero, or >= phase_cap override is ignored so the operator
  -- cannot silently grant extra sends by omission.
  IF override_val IS NOT NULL AND override_val > 0 AND override_val < phase_cap THEN
    RETURN override_val;
  END IF;
  RETURN phase_cap;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── 4. advance_lifecycle_phase — cron calls this daily ───────────────────────

CREATE OR REPLACE FUNCTION advance_lifecycle_phase() RETURNS INT AS $$
DECLARE
  updated INT;
BEGIN
  WITH advanced AS (
    UPDATE outreach_mailboxes
       SET lifecycle_phase = CASE
         WHEN NOW() - created_at >= INTERVAL '30 days' THEN 'production'
         WHEN NOW() - created_at >= INTERVAL '14 days' THEN 'warmup_d14'
         WHEN NOW() - created_at >= INTERVAL '7 days'  THEN 'warmup_d7'
         WHEN NOW() - created_at >= INTERVAL '3 days'  THEN 'warmup_d3'
         ELSE 'warmup_d0'
       END
     WHERE lifecycle_phase != CASE
         WHEN NOW() - created_at >= INTERVAL '30 days' THEN 'production'
         WHEN NOW() - created_at >= INTERVAL '14 days' THEN 'warmup_d14'
         WHEN NOW() - created_at >= INTERVAL '7 days'  THEN 'warmup_d7'
         WHEN NOW() - created_at >= INTERVAL '3 days'  THEN 'warmup_d3'
         ELSE 'warmup_d0'
       END
       AND status NOT IN ('retired')
     RETURNING 1
  )
  SELECT count(*) INTO updated FROM advanced;
  RETURN updated;
END;
$$ LANGUAGE plpgsql;

-- ── 5. enforce_warmup_cap trigger ────────────────────────────────────────────
--
-- Fires BEFORE INSERT on send_events.
-- Reads the mailbox's current phase + daily_cap_override, counts today's
-- sends (in Prague time), and rejects the INSERT if the cap is exhausted.
--
-- Mailboxes not present in outreach_mailboxes (test fixtures, manual probes)
-- are allowed through — the trigger returns NEW without checking.

CREATE OR REPLACE FUNCTION enforce_warmup_cap() RETURNS TRIGGER AS $$
DECLARE
  current_phase TEXT;
  cap           INT;
  override_val  INT;
  sent_today    INT;
  mailbox_addr  TEXT;
BEGIN
  SELECT lifecycle_phase, daily_cap_override, from_address
    INTO current_phase, override_val, mailbox_addr
    FROM outreach_mailboxes
   WHERE from_address = NEW.mailbox_used
   LIMIT 1;

  IF current_phase IS NULL THEN
    -- Mailbox not in our DB (test fixture, manual probe) — allow
    RETURN NEW;
  END IF;

  cap := compute_daily_cap(current_phase, override_val);

  SELECT count(*) INTO sent_today
    FROM send_events
   WHERE mailbox_used = NEW.mailbox_used
     AND sent_at >= (NOW() AT TIME ZONE 'Europe/Prague')::date
     AND status IN ('sent', 'queued');

  IF sent_today >= cap THEN
    RAISE EXCEPTION 'warmup_cap_exceeded: mailbox=% phase=% sent_today=% cap=%',
      mailbox_addr, current_phase, sent_today, cap
      USING ERRCODE = '23514';  -- check_violation — closest standard code
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_warmup_cap ON send_events;
CREATE TRIGGER trg_enforce_warmup_cap
  BEFORE INSERT ON send_events
  FOR EACH ROW EXECUTE FUNCTION enforce_warmup_cap();

-- ── 6. schema_migrations ─────────────────────────────────────────────────────

INSERT INTO schema_migrations (version)
VALUES ('071_mailbox_lifecycle_caps')
ON CONFLICT (version) DO NOTHING;

COMMIT;
