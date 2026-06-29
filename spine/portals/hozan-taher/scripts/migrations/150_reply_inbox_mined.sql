-- 150_reply_inbox_mined.sql
--
-- Persist mined reply signals (#1578 M1 persistence). mineReplySignals() pulls
-- the high-value structured signals out of a reply body — phone numbers, CZK
-- prices, callback/urgency intent, location — that the operator acts on. Until
-- now this was computed on-read in GET /api/replies/:id and never stored, so the
-- LIST endpoint could not filter or aggregate on it ("show me replies that left
-- a phone number" — the highest-value výkup queue).
--
-- Shape (matches lib/mineReplySignals.js output):
--   { phones:[{display,tel}], prices:[{amount,currency,raw}],
--     callback:bool, urgent:bool, locations:[string] }
--
-- Population: backfilled once over existing rows by scripts/backfill-reply-mined.js
-- (the miner is JS), then kept fresh lazily on each GET /:id read (compute +
-- persist when mined IS NULL). New inbound is mined on its first detail open.
--
-- Idempotent (IF NOT EXISTS). Applied to PROD 2026-06-01.

ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS mined jsonb;

-- GIN index for containment/key-presence filters on the list endpoint
-- (e.g. has-phone, callback, urgent). Partial: only rows actually mined.
CREATE INDEX IF NOT EXISTS idx_reply_inbox_mined
  ON reply_inbox USING gin (mined)
  WHERE mined IS NOT NULL;
