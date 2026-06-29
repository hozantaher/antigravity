-- 117 — notify_reply_inserted trigger function: jsonb-safe column access
--
-- 2026-05-18 — root cause of 5-day silent ingestion failure: trigger fn
-- referenced NEW.from_email which exists in reply_inbox but NOT in
-- unmatched_inbound (column name is from_address there). Every INSERT
-- into unmatched_inbound failed with:
--   pq: record "new" has no field "from_email" (42703)
--
-- Effect: parkUnattributed in services/orchestrator/thread/inbound.go
-- silently swallowed every "no matching thread" reply for ~5 days. 26
-- customer replies stuck in INBOX (recovered via watermark backfill on
-- 2026-05-18 after this fix). 13 of those leads include "Karel Dvořák,
-- K+K služby — prodej PSS rýpadlo" type real customer interest.
--
-- Fix: switch from direct NEW.column refs to to_jsonb(NEW) ->> 'column'
-- lookups so missing keys return NULL instead of raising 42703. Both
-- reply_inbox (has from_email) and unmatched_inbound (has from_address)
-- now share the same trigger fn without column-name drift.
--
-- Applied to PROD via psql on 2026-05-18 ~11:00 UTC. This file ensures
-- future DB rebuilds re-apply the fix; the migration runner is also
-- idempotent (CREATE OR REPLACE).
--
-- HARD rule feedback_audit_log_on_mutations: a follow-up audit ratchet
-- (tests/audit/notify_reply_trigger_safe.test.js) verifies the function
-- body uses to_jsonb pattern, so future agents can't silently revert
-- this fix.

CREATE OR REPLACE FUNCTION notify_reply_inserted() RETURNS TRIGGER AS $$
DECLARE
  rec jsonb := to_jsonb(NEW);
BEGIN
  PERFORM pg_notify(
    'reply_inserted',
    json_build_object(
      'source',      TG_TABLE_NAME,
      'id',          NEW.id,
      'from',        COALESCE(rec ->> 'from_email', rec ->> 'from_address', ''),
      'received_at', COALESCE(rec ->> 'received_at', now()::text)
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
