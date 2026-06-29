-- 114_reply_inbox_pre_classification.sql — Sprint AC8 Haiku pre-classification
--
-- Adds a JSONB column `pre_classification` on `reply_inbox` to carry the
-- Haiku LLM pre-tag emitted at IMAP ingest time. The tag is metadata for
-- the operator UI filter; no auto-actions are wired off it (those land
-- in Sprint AC9). Shape:
--
--   {
--     "intent": "positive|negative|info_request|unsubscribe|bounce|unknown",
--     "confidence": 0.0..1.0,
--     "model_used": "<anthropic model id>",
--     "reasoning": "<short rationale>",
--     "classified_at": "<RFC3339 UTC>"
--   }
--
-- NULL = not yet classified (e.g. classifier disabled, API key missing,
-- or row inserted before AC8 deployment).
--
-- HARD RULE feedback_verify_select_after_migration (T0): the caller MUST
-- run the following verifier after `psql -f`:
--
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'reply_inbox' AND column_name = 'pre_classification';
--
-- HARD RULE feedback_schema_verify_before_sql (T0): the verified columns
-- of reply_inbox at the time of writing this migration are:
--   id, campaign_id, classification, contact_id, from_email, handled,
--   handled_at, mailbox_id, received_at, send_event_id, subject.
-- See PR body for the `\d reply_inbox` snapshot.

BEGIN;

ALTER TABLE reply_inbox
  ADD COLUMN IF NOT EXISTS pre_classification JSONB DEFAULT NULL;

COMMENT ON COLUMN reply_inbox.pre_classification IS
  'AC8: Haiku LLM pre-tag {intent: positive|negative|info_request|unsubscribe|bounce|unknown, confidence: 0.0-1.0, model_used, reasoning, classified_at}. NULL = not yet classified. No auto-actions in AC8 — operator UI filter only.';

CREATE INDEX IF NOT EXISTS idx_reply_inbox_pre_classification_intent
  ON reply_inbox ((pre_classification->>'intent'))
  WHERE pre_classification IS NOT NULL;

INSERT INTO schema_migrations(migration_id, filename, content_sha256, applied_by)
  VALUES ('114', '114_reply_inbox_pre_classification.sql', 'manual-apply', 'ac8-agent')
  ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
