-- 123_reply_classifications_log.sql
--
-- AV-F2 (2026-05-19): persistent log of every classifier verdict (regex
-- now, LLM in Phase B) so operator overrides + accuracy can be tracked
-- across classifier versions. Companion to the in-memory classifier
-- library (apps/outreach-dashboard/src/lib/replyClassifier.js).
--
-- Schema verified 2026-05-19 via `\d reply_inbox` + `\d unmatched_inbound`:
--   reply_inbox.id          BIGINT  PK
--   unmatched_inbound.id    BIGINT  PK
-- The operator-facing reply ID is signed:
--   positive →  reply_inbox.id
--   negative → -unmatched_inbound.id
-- This column keeps that same signed convention so a single log row can
-- belong to either source without a discriminator column. Selection is
-- by sign:  reply_id > 0  →  reply_inbox    /    reply_id < 0  →  unmatched_inbound.
-- Per feedback_schema_verify_before_sql T0.
--
-- Predecessor: 122_backfill_unmatched_to_reply_inbox.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '122_backfill_unmatched_to_reply_inbox'
  ) THEN
    RAISE EXCEPTION 'Predecessor 122_backfill_unmatched_to_reply_inbox not applied';
  END IF;
END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS reply_classifications_log (
  id BIGSERIAL PRIMARY KEY,
  -- Signed reply id (positive=reply_inbox, negative=-unmatched_inbound).
  reply_id BIGINT NOT NULL,
  -- 'regex_v1', 'llm_v1', etc. Idempotency key together with reply_id.
  classifier_version TEXT NOT NULL,
  -- One of: positive | negative | question | auto_reply | bounce | unsubscribe | null
  classification TEXT,
  -- Confidence 0.000 – 1.000.
  confidence NUMERIC(4,3) NOT NULL,
  -- Free-shape JSON: {matched_patterns: [...], score_breakdown: {...}}
  reasoning JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- TRUE when the verdict crossed the auto-apply threshold and was
  -- written back to reply_inbox/unmatched_inbound.classification.
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  -- If the operator later disagreed, what label they picked.
  operator_override TEXT,
  operator_override_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reply_classifications_reply_id
  ON reply_classifications_log(reply_id);

-- Partial index: rows the operator should review (low confidence + no
-- override yet). Keeps the per-reply-detail lookup fast.
CREATE INDEX IF NOT EXISTS idx_reply_classifications_low_confidence
  ON reply_classifications_log(reply_id)
  WHERE confidence < 0.75 AND operator_override IS NULL;

-- Idempotency: one verdict per (reply_id, classifier_version). The
-- POST /api/replies/:id/auto-classify endpoint relies on this to be
-- safe to call repeatedly (replays a cron tick → no duplicate rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_classifications_unique
  ON reply_classifications_log(reply_id, classifier_version);

INSERT INTO schema_migrations (version)
  VALUES ('123_reply_classifications_log')
  ON CONFLICT DO NOTHING;

COMMIT;

-- Verification (feedback_verify_select_after_migration T0):
\echo '── Table created: ──'
SELECT to_regclass('reply_classifications_log') AS table_oid;

\echo '── Columns: ──'
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'reply_classifications_log'
 ORDER BY ordinal_position;

\echo '── Indexes: ──'
SELECT indexname FROM pg_indexes WHERE tablename = 'reply_classifications_log' ORDER BY indexname;

\echo '── Migration recorded: ──'
SELECT version FROM schema_migrations WHERE version = '123_reply_classifications_log';

-- Audit log mutation (feedback_audit_log_on_mutations T0).
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES (
  'schema_migration_applied',
  'migration',
  'schema_migrations',
  '123',
  jsonb_build_object(
    'migration', '123_reply_classifications_log.sql',
    'reason', 'AV-F2: persistent verdict log for regex/LLM reply classifiers.'
  )
);
