-- 101_manual_reply_outbox_attachments_inline.sql
--
-- Sprint 2.2 fix-up. Migration 100 introduced a join table from
-- manual_reply_outbox → message_attachments. That ran into a schema
-- mismatch: message_attachments.message_id is NOT NULL and references
-- outreach_messages — which doesn't exist yet for an outbound reply
-- that hasn't been sent. So storing the file BYTEA directly on the
-- outbox attachment row is the correct shape.
--
-- This migration redoes the join: drops the foreign-key style table
-- from migration 100 and replaces it with an inline-data table that
-- owns its own filename/content_type/size/data/sha256 columns. After
-- the outbound worker (runOutboundReplyCron) successfully ships the
-- reply via relay /v1/submit and inserts an outreach_messages row with
-- direction='outbound', it can OPTIONALLY copy the rows into
-- message_attachments linked to that message_id — left as a follow-up.
--
-- Idempotent: DROP TABLE IF EXISTS + CREATE TABLE IF NOT EXISTS.

BEGIN;

-- Drop the old (mis-shaped) join from migration 100 if it exists.
-- ON DELETE CASCADE in migration 100 means dropping is safe — no rows
-- can survive without an outbox parent.
DROP TABLE IF EXISTS manual_reply_outbox_attachments;

CREATE TABLE IF NOT EXISTS manual_reply_outbox_attachments (
  id             BIGSERIAL PRIMARY KEY,
  outbox_id      BIGINT  NOT NULL REFERENCES manual_reply_outbox(id) ON DELETE CASCADE,
  position       SMALLINT NOT NULL DEFAULT 0,
  filename       TEXT     NOT NULL,
  content_type   TEXT     NOT NULL,
  size_bytes     INTEGER  NOT NULL,
  data           BYTEA    NOT NULL,
  sha256         TEXT     NOT NULL,
  is_inline      BOOLEAN  NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_reply_outbox_attachments_outbox
  ON manual_reply_outbox_attachments (outbox_id, position);

INSERT INTO schema_migrations (migration_id, filename, applied_by)
VALUES ('101_manual_reply_outbox_attachments_inline',
        '101_manual_reply_outbox_attachments_inline.sql',
        'mail-client-sprint-2-2026-05-12')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
