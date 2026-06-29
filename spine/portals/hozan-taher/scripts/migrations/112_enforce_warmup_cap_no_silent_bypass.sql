-- 112_enforce_warmup_cap_no_silent_bypass.sql
--
-- INCIDENT 2026-05-13: paused campaign 457 had 17 unauthorized sends from
-- DELETED mailboxes (nowak.goran / goran.nowak) between 15:00–15:34 UTC.
--
-- Root cause (one of three):
--   The enforce_warmup_cap() trigger (migrations 071 + 079) contained:
--
--       SELECT lifecycle_phase, status, ... INTO current_phase, current_status, ...
--         FROM outreach_mailboxes WHERE from_address = NEW.mailbox_used LIMIT 1;
--       IF current_phase IS NULL THEN
--         -- Mailbox not in our DB (test fixture, manual probe) — allow
--         RETURN NEW;
--       END IF;
--
--   The "test fixture, manual probe" silent-allow bypass let the Go runner
--   (which still had the deleted mailboxes loaded from env-var MAILBOX_N_*
--   fallback in services/common/config/config.go LoadFromEnv) INSERT into
--   send_events even though the operator had hard-deleted the registry rows
--   at 14:18 UTC. 17 emails left the platform before the trigger was live-
--   patched at 15:35 UTC.
--
-- Fix:
--   Replace the "RETURN NEW" silent-allow with RAISE EXCEPTION. A mailbox
--   sending email MUST be present in outreach_mailboxes. There is no
--   legitimate path that inserts send_events for a row that doesn't exist;
--   test fixtures should seed the row first, manual probes should use a
--   real registry row, and the Go engine's env-var fallback is the actual
--   bug (closed in companion code change services/campaigns/sender/engine.go).
--
-- Live-patched in PROD 2026-05-13 15:35 UTC. This file is the canonical
-- source that survives a redeploy / restore.
--
-- Predecessor: 111_machinery_score_priority.sql
--
-- Apply:
--   psql "$DATABASE_URL" -f scripts/migrations/112_enforce_warmup_cap_no_silent_bypass.sql
--
-- Verify post-apply:
--   psql "$DATABASE_URL" -c '\sf enforce_warmup_cap'
--   -- expect "mailbox_not_in_db" RAISE EXCEPTION, NOT "RETURN NEW" silent allow

BEGIN;

CREATE OR REPLACE FUNCTION enforce_warmup_cap() RETURNS TRIGGER AS $$
DECLARE
  current_phase  TEXT;
  current_status TEXT;
  cap            INT;
  override_val   INT;
  sent_today     INT;
  mailbox_addr   TEXT;
BEGIN
  -- Only gate true send activity. status='failed' / 'bounced' / etc. are
  -- post-hoc bookkeeping rows that shouldn't trip the cap.
  IF NEW.status IS NULL OR NEW.status NOT IN ('sent', 'queued', 'sealed') THEN
    RETURN NEW;
  END IF;

  SELECT lifecycle_phase, status, daily_cap_override, from_address
    INTO current_phase, current_status, override_val, mailbox_addr
    FROM outreach_mailboxes
   WHERE from_address = NEW.mailbox_used
   LIMIT 1;

  -- 2026-05-13 incident hardening: no silent allow when mailbox is missing.
  -- The Go engine env-var fallback (MAILBOX_N_*) is NOT a legitimate source
  -- of truth for send_events — it must round-trip through outreach_mailboxes.
  IF NOT FOUND OR current_phase IS NULL THEN
    RAISE EXCEPTION 'mailbox_not_in_db: mailbox=% has no row in outreach_mailboxes — env-var fallback blocked (incident 2026-05-13)',
      NEW.mailbox_used
      USING ERRCODE = '23514';  -- check_violation
  END IF;

  -- Reject INSERT if mailbox is not in an active lifecycle status.
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
     AND status IN ('sent', 'queued', 'sealed');

  IF sent_today >= cap THEN
    RAISE EXCEPTION 'warmup_cap_exceeded: mailbox=% phase=% sent_today=% cap=%',
      mailbox_addr, current_phase, sent_today, cap
      USING ERRCODE = '23514';  -- check_violation
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (version)
  VALUES ('112_enforce_warmup_cap_no_silent_bypass')
  ON CONFLICT DO NOTHING;

COMMIT;
