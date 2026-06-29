-- 145_reply_inbox_source_unmatched.sql
--
-- Reconnect migrated replies to their orphan photos. When the operator replies
-- to an unmatched (orphan) reply, replyMultipart promotes it into reply_inbox —
-- but the seller's photos stay in unmatched_inbound_attachments (keyed by the
-- ORIGINAL unmatched_inbound.id), and the new reply_inbox row had no link back.
-- So a promoted lead's photos were stranded (operator 2026-06-01 "netěží fotky").
--
-- Add the link + backfill it for existing migrated rows by matching on the
-- exact (from_email, received_at) the promotion copies. The dashboard then
-- serves a reply_inbox row's photos from the linked unmatched_id when the reply
-- has no own reply_inbox_attachments (pre-144 / promoted rows).

ALTER TABLE reply_inbox
  ADD COLUMN IF NOT EXISTS source_unmatched_id BIGINT;

-- Backfill: link promoted reply_inbox rows to their origin unmatched_inbound row.
-- unmatched_inbound.classification='migrated_to_reply_inbox' marks the promoted
-- originals; match on the copied (from_email/from_address + received_at).
UPDATE reply_inbox r
   SET source_unmatched_id = u.id
  FROM unmatched_inbound u
 WHERE u.classification = 'migrated_to_reply_inbox'
   AND r.source_unmatched_id IS NULL
   AND lower(r.from_email) = lower(u.from_address)
   AND r.received_at = u.received_at;

CREATE INDEX IF NOT EXISTS reply_inbox_source_unmatched_id_idx
  ON reply_inbox(source_unmatched_id) WHERE source_unmatched_id IS NOT NULL;
