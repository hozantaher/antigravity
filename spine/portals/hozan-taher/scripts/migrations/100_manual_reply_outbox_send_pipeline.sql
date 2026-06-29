-- 100_manual_reply_outbox_send_pipeline.sql
--
-- Sprint 2.1 (mail-client init 2026-05-12) — extend manual_reply_outbox
-- so the orchestrator's outbound worker can pick rows up, build a MIME
-- reply, dispatch via anti-trace-relay /v1/submit, and persist the
-- outcome.
--
-- Existing columns (migration 050): id, body, reply_inbox_id.
-- New columns:
--   subject_override  — optional; when empty the worker derives "Re: <orig>"
--                       from reply_inbox.subject (RFC 5322 §3.6.5 threading).
--   sent_at           — NULL while pending; UTC timestamp on success.
--   envelope_id       — relay-assigned id (env_xxx) after /v1/submit returns
--                       HTTP 202; useful for later delivery audit cross-ref.
--   error             — last failure reason; cleared on success.
--   attempts          — retry counter; worker stops after MAX_OUTBOX_ATTEMPTS
--                       (default 3, env var).
--
-- New table:
--   manual_reply_outbox_attachments — links message_attachments rows to an
--   outbox row so the worker can pull file blobs at send time.
--   Cascade on outbox row delete; ON DELETE SET NULL on attachment delete
--   (attachment may be retained for audit even if outbox row is purged).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.

BEGIN;

ALTER TABLE manual_reply_outbox
  ADD COLUMN IF NOT EXISTS subject_override TEXT,
  ADD COLUMN IF NOT EXISTS sent_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS envelope_id      TEXT,
  ADD COLUMN IF NOT EXISTS error            TEXT,
  ADD COLUMN IF NOT EXISTS attempts         INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- Pending queue index — worker selects WHERE sent_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_manual_reply_outbox_pending
  ON manual_reply_outbox (created_at)
  WHERE sent_at IS NULL;

-- Attachments link table. Outbox-to-attachments is N:1 (one outbox row
-- can have multiple files). message_attachments already exists from
-- migration 013; we only add the join table here.
CREATE TABLE IF NOT EXISTS manual_reply_outbox_attachments (
  outbox_id       BIGINT NOT NULL REFERENCES manual_reply_outbox(id) ON DELETE CASCADE,
  attachment_id   BIGINT NOT NULL REFERENCES message_attachments(id) ON DELETE SET NULL,
  position        SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (outbox_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_reply_outbox_attachments_outbox
  ON manual_reply_outbox_attachments (outbox_id);

INSERT INTO schema_migrations (migration_id, filename, applied_by)
VALUES ('100_manual_reply_outbox_send_pipeline',
        '100_manual_reply_outbox_send_pipeline.sql',
        'mail-client-sprint-2-2026-05-12')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
