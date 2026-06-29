-- 012_outreach_messages_full_body — store full email body, not just preview.
--
-- Background: services/orchestrator/thread/messages.go RecordInbound truncates
-- inbound mail to a 200-char `body_preview`. HTML alternative, full plain text,
-- and any attachments are dropped on the IMAP poller floor (poller fetches
-- BODY[TEXT] only — see services/orchestrator/imap/poller.go:364).
--
-- Result today: ThreadDetail UI renders subject as message body. Inline images
-- never reach the database. Operators can't see what the prospect actually said
-- past 200 characters.
--
-- This migration adds the columns that S1.4 RecordInbound (initiative
-- 2026-04-29-mail-client-fidelity.md) needs for full fidelity persistence.
-- It does NOT backfill — old rows keep their body_preview only. UI fallback
-- chain (S2.3): body_html → body_text → body_preview.
--
-- Storage decision (per initiative): stay in Postgres for MVP. Average B2B
-- thread is ~5 messages × ~2KB body = ~10KB/thread. HTML adds maybe 4× over
-- plain text; still <100KB/thread. Bytea for attachments lives in the separate
-- 012_message_attachments table.
--
-- Idempotency: every ALTER uses IF NOT EXISTS.

BEGIN;

ALTER TABLE outreach_messages
  ADD COLUMN IF NOT EXISTS body_text TEXT;

ALTER TABLE outreach_messages
  ADD COLUMN IF NOT EXISTS body_html TEXT;

ALTER TABLE outreach_messages
  ADD COLUMN IF NOT EXISTS body_html_raw TEXT;

ALTER TABLE outreach_messages
  ADD COLUMN IF NOT EXISTS body_size_bytes INTEGER;

COMMENT ON COLUMN outreach_messages.body_text IS
  'Plain-text body extracted from MIME. NULL for legacy rows (use body_preview).';

COMMENT ON COLUMN outreach_messages.body_html IS
  'Sanitized HTML body (bluemonday UGCPolicy). UI may render via dangerouslySetInnerHTML.';

COMMENT ON COLUMN outreach_messages.body_html_raw IS
  'Pre-sanitization HTML. Retained for DSR Article 15 export only — NEVER served to UI.';

COMMENT ON COLUMN outreach_messages.body_size_bytes IS
  'Total RFC822 size in bytes (incl. headers + parts). For storage analytics.';

COMMIT;

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
