-- 149_reply_inbox_flagged.sql
--
-- Flag / star a reply (mail-client triage). The operator marks a conversation
-- "return to this" independently of handled — e.g. a hot lead to revisit, or a
-- reply to follow up after a call. Distinct from handled (archived) and from
-- classification (what kind of reply).
--
-- reply_inbox only: flag is a matched-lead action, mirroring how classification
-- + the v2 toolbar already operate on positive ids. unmatched_inbound reports
-- flagged=false in the list union.
--
-- Idempotent (IF NOT EXISTS). Applied to PROD 2026-06-01.

ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS flagged    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reply_inbox ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;

-- Partial index so the "Označené" lane (flagged = TRUE) is a cheap lookup
-- rather than a scan of the whole table.
CREATE INDEX IF NOT EXISTS idx_reply_inbox_flagged
  ON reply_inbox (flagged_at DESC)
  WHERE flagged = TRUE;
