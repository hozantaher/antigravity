-- 128_reply_inbox_body_columns.sql
-- G3.7.1: Add body_text, body_html, attachments_meta, headers_json to reply_inbox.
--
-- Pre-migration shape (feedback_schema_verify_before_sql T0 — verified 2026-05-29):
--   12 columns: id, campaign_id, classification, contact_id, from_email,
--   handled, handled_at, mailbox_id, received_at, send_event_id, subject,
--   pre_classification
--
-- Post-migration shape: 16 columns (4 added).
--
-- GIN index on attachments_meta enables future "has_pdf" / "has_attachment"
-- filter queries without full-table scans. Index type GIN is appropriate for
-- JSONB array-shaped payloads (vs. btree which suits scalar keys).
--
-- headers_json stores boolean auth flags only (SPF/DKIM/DMARC pass/fail) plus
-- selected scalar headers (Message-ID, In-Reply-To, References, Date,
-- Content-Type). NO raw Received chain, NO IP addresses
-- (feedback_no_pii_in_logs T0).

BEGIN;

ALTER TABLE reply_inbox
  ADD COLUMN IF NOT EXISTS body_text         TEXT,
  ADD COLUMN IF NOT EXISTS body_html         TEXT,
  ADD COLUMN IF NOT EXISTS attachments_meta  JSONB,
  ADD COLUMN IF NOT EXISTS headers_json      JSONB;

-- GIN index on attachments_meta for future has_attachment / mime_type filter
-- queries (e.g. "show replies with PDF"). Partial: only rows that actually
-- have attachments, keeping index small for the common attachment-free case.
CREATE INDEX IF NOT EXISTS idx_reply_inbox_attachments_meta
  ON reply_inbox USING GIN (attachments_meta)
  WHERE attachments_meta IS NOT NULL;

-- Audit log (feedback_audit_log_on_mutations T0)
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'schema_migration',
  'system',
  'table',
  NULL,
  jsonb_build_object(
    'migration',     '128_reply_inbox_body_columns',
    'added_columns', ARRAY['body_text', 'body_html', 'attachments_meta', 'headers_json'],
    'note',          'G3.7.1 — store matched-reply body content, eliminating 68% IMAP data loss at schema fence'
  )
);

-- Verify (feedback_verify_select_after_migration T0)
DO $$
DECLARE missing_cols TEXT;
BEGIN
  SELECT string_agg(col, ', ') INTO missing_cols
  FROM (
    VALUES ('body_text'), ('body_html'), ('attachments_meta'), ('headers_json')
  ) AS expected(col)
  WHERE col NOT IN (
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'reply_inbox'
  );

  IF missing_cols IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 128 incomplete — columns still missing: %', missing_cols;
  END IF;

  RAISE NOTICE 'Migration 128 verified — all 4 columns present in reply_inbox';
END $$;

INSERT INTO schema_migrations (version) VALUES ('128_reply_inbox_body_columns') ON CONFLICT DO NOTHING;

COMMIT;
