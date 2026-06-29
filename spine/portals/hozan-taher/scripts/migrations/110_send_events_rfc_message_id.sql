-- 110_send_events_rfc_message_id.sql — Sprint R2 reply-pipeline-recovery
--
-- Adds an RFC 5322 Message-ID column to send_events so the inbound reply
-- matcher can attribute replies whose In-Reply-To header references our
-- canonical Message-ID (e.g. "<HMAC@domain>") instead of our internal
-- envelope_id ("env_XXX"). The existing message_id column stores the
-- envelope_id and never appears in real reply headers, which broke
-- attribution for 146+ rows that never matched anything (Sprint R1 RCA).
--
-- IDEMPOTENT: both the column and index already exist in PROD (manually
-- backfilled 2026-05-13 12:14). This file records the schema change in git
-- so a rebuilt environment converges.
--
-- HARD RULE feedback_verify_select_after_migration: callers must run
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='send_events' AND column_name='rfc_message_id';
-- after applying.

ALTER TABLE send_events
  ADD COLUMN IF NOT EXISTS rfc_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_send_events_rfc_msgid
  ON send_events (rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;

COMMENT ON COLUMN send_events.rfc_message_id IS
  'RFC 5322 Message-ID header value (without angle brackets) as emitted on the wire. Used by services/orchestrator/thread/inbound.matchToThread for reply attribution. Distinct from message_id which stores the internal anti-trace envelope_id.';
