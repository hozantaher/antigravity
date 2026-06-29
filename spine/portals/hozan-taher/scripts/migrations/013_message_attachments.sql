-- 013_message_attachments — store inline images + downloadable attachments
-- alongside outreach_messages.
--
-- Required by initiative docs/initiatives/2026-04-29-mail-client-fidelity.md
-- (S1 Capture).
--
-- Storage decision (per initiative): bytea in Postgres. <10MB attachment limit
-- × max 3 per message = ≤30MB row. PG handles this fine; GDPR Art. 17 cascade
-- works via FK; no S3/external service (per memory feedback_no_external_services).
-- Upgrade-path to object store is a future migration if growth metric trips.
--
-- content_id semantics:
--   * NULL                          → non-inline attachment (download chip)
--   * 'cid-foo' (no angle brackets) → inline part referenced by `<img src="cid:cid-foo">`
-- Stored without the angle brackets to simplify substring matching at BFF
-- read time. The MIME parser strips them before INSERT.
--
-- sha256 column purpose: deduplicate identical attachments inside a single
-- thread (e.g. 30-message exchange where the prospect's signature logo
-- repeats every reply — 30× the same 50KB PNG would be 1.5MB wasted).
-- For MVP we DO NOT dedupe (each message owns its attachments outright);
-- sha256 is recorded so a future optimization can collapse duplicates
-- without a schema change.

BEGIN;

CREATE TABLE IF NOT EXISTS message_attachments (
  id            BIGSERIAL PRIMARY KEY,
  message_id    BIGINT NOT NULL
                  REFERENCES outreach_messages(id) ON DELETE CASCADE,
  content_id    TEXT,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
  data          BYTEA NOT NULL,
  is_inline     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- All-rows index — used by BFF list of attachments per message (S2.1).
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id
  ON message_attachments (message_id);

-- Partial index — used by BFF /api/messages/:id/attachments/:cid lookup
-- (S2.2). Skipping NULL content_id rows keeps it tiny — most non-inline
-- attachments are looked up by filename, not cid.
CREATE INDEX IF NOT EXISTS idx_message_attachments_cid
  ON message_attachments (message_id, content_id)
  WHERE content_id IS NOT NULL;

COMMENT ON TABLE message_attachments IS
  'Inline images + downloadable attachments. ON DELETE CASCADE from outreach_messages — deletion is the GDPR Art. 17 cascade path (DSR erase) per S1.6.';

COMMENT ON COLUMN message_attachments.content_id IS
  'MIME Content-ID without angle brackets. NULL for non-inline. Inline parts referenced by HTML body via cid:<value>.';

COMMENT ON COLUMN message_attachments.sha256 IS
  'Hex-encoded SHA-256 of `data`. Recorded for future dedupe; not enforced unique.';

COMMIT;

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
