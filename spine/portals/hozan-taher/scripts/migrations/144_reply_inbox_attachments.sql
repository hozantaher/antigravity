-- 144_reply_inbox_attachments.sql
--
-- Photo mining for MATCHED replies (operator 2026-06-01: "pořád to netěží
-- fotky"). Background: orphan replies keep their attachment BYTES in
-- unmatched_inbound_attachments (103), so their seller photos are servable.
-- But MATCHED replies (the hot leads operators actually triage) only kept
-- attachment METADATA in reply_inbox.attachments_meta — the bytes went to the
-- optional photostore (Railway volume, Schema-B keyed) or were dropped, and the
-- local dashboard can't serve them. Result: capturing a vehicle from a hot-lead
-- reply pulled no photos.
--
-- This sibling table (mirrors unmatched_inbound_attachments, keyed off
-- reply_inbox.id) gives matched replies a servable byte store. The orchestrator
-- writes here in insertReplyInbox; the dashboard serves via
-- GET /api/messages/:id/attachments/:idx (positive id) + the manifest.

CREATE TABLE IF NOT EXISTS reply_inbox_attachments (
  id BIGSERIAL PRIMARY KEY,
  reply_inbox_id BIGINT NOT NULL REFERENCES reply_inbox(id) ON DELETE CASCADE,
  idx INT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INT NOT NULL DEFAULT 0,
  data BYTEA NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  is_inline BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reply_inbox_attachments_unique_idx UNIQUE (reply_inbox_id, idx)
);

CREATE INDEX IF NOT EXISTS reply_inbox_attachments_reply_inbox_id_idx
  ON reply_inbox_attachments(reply_inbox_id);
