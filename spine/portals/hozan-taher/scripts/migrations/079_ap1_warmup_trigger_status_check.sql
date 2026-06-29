-- 079_ap1_warmup_trigger_status_check.sql
--
-- P2.12: Hardening enforce_warmup_cap trigger — add status guard
--
-- Problem:
--   The enforce_warmup_cap trigger (migration 071) fires on send_events INSERT
--   for any mailbox, regardless of its status. If an operator manually INSERTs
--   into send_events with a paused/auth_locked/retired mailbox, the trigger
--   permits it (current_phase lookup succeeds) and enforces warmup cap even
--   though the mailbox is not active.
--
-- Fix:
--   Modify trigger to reject INSERT when mailbox status is NOT IN
--   ('active', 'warmup_d0', 'warmup_d3', 'warmup_d7', 'warmup_d14', 'production').
--   This ensures only active mailboxes consume the cap counter.
--
-- Backward compat:
--   Existing send_events rows are unchanged. Trigger only affects future INSERTs.
--
-- Predecessor: 078_send_events_warmup_cap_idx.sql
--
-- Apply:
--   psql "$DATABASE_URL" -f scripts/migrations/079_ap1_warmup_trigger_status_check.sql

BEGIN;

CREATE OR REPLACE FUNCTION enforce_warmup_cap() RETURNS TRIGGER AS $$
DECLARE
  current_phase TEXT;
  current_status TEXT;
  cap           INT;
  override_val  INT;
  sent_today    INT;
  mailbox_addr  TEXT;
BEGIN
  SELECT lifecycle_phase, status, daily_cap_override, from_address
    INTO current_phase, current_status, override_val, mailbox_addr
    FROM outreach_mailboxes
   WHERE from_address = NEW.mailbox_used
   LIMIT 1;

  IF current_phase IS NULL THEN
    -- Mailbox not in our DB (test fixture, manual probe) — allow
    RETURN NEW;
  END IF;

  -- P2.12: Reject INSERT if mailbox is not active (paused, auth_locked, retired, etc.)
  IF current_status NOT IN ('active', 'warmup_d0', 'warmup_d3', 'warmup_d7', 'warmup_d14', 'production') THEN
    RAISE EXCEPTION 'warmup_cap_status_guard: mailbox=% status=% (not active)',
      mailbox_addr, current_status
      USING ERRCODE = '23514';  -- check_violation
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

INSERT INTO schema_migrations (version)
  VALUES ('079_ap1_warmup_trigger_status_check')
  ON CONFLICT DO NOTHING;

COMMIT;
