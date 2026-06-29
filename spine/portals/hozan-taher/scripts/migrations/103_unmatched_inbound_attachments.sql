-- 103_unmatched_inbound_attachments.sql
--
-- Sprint B2 (issue #1248) — attachments for orphan replies.
--
-- Background: when the orchestrator's thread.ProcessReply can't match an
-- inbound mail to any send_event, it parks the row in unmatched_inbound.
-- Today only headers + body_preview survive — any attachments the sender
-- included (photos, PDFs, invoices) are dropped. The operator opens the
-- orphan reply in ThreadDetail and sees no indication that there were
-- attachments at all.
--
-- For matched replies the orchestrator writes attachments to
-- message_attachments (FK → outreach_messages). Orphans have no parent
-- outreach_messages row, so we need a sibling table keyed off
-- unmatched_inbound.id instead.
--
-- Schema mirrors message_attachments where it makes sense (BYTEA blob,
-- content_type, filename, sha256). Drops the message_id FK and the
-- send_event_id reference that orphans never have.

CREATE TABLE IF NOT EXISTS unmatched_inbound_attachments (
  id BIGSERIAL PRIMARY KEY,
  unmatched_id BIGINT NOT NULL REFERENCES unmatched_inbound(id) ON DELETE CASCADE,
  idx INT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INT NOT NULL DEFAULT 0,
  data BYTEA NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  is_inline BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unmatched_inbound_attachments_unique_idx UNIQUE (unmatched_id, idx)
);

CREATE INDEX IF NOT EXISTS unmatched_inbound_attachments_unmatched_id_idx
  ON unmatched_inbound_attachments(unmatched_id);

-- Also add body_html to unmatched_inbound so the HTML variant can be
-- rendered in ThreadDetail (Sprint B3). Existing rows get NULL; the
-- orchestrator's parkUnattributed populates it on next re-fetch via
-- the ON CONFLICT UPDATE path introduced in PR #1240-followup.
ALTER TABLE unmatched_inbound
  ADD COLUMN IF NOT EXISTS body_html TEXT;
