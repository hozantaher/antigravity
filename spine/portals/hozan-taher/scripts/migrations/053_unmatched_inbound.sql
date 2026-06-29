-- 053_unmatched_inbound.sql
--
-- Creates the unmatched_inbound table used by the reply-attribution fallback
-- ladder (thread/inbound.go: parkUnattributed). When Message-ID chain, exact
-- email, and domain match all fail, the inbound reply is parked here for
-- operator review rather than silently discarded.
--
-- Predecessor: 052_contacts_status_constraint_v2.sql

-- Verify predecessor was applied. schema_migrations.version is text (no
-- .sql extension); existing 051 entry is the actual predecessor.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '051_contacts_status_constraint_extend'
  ) THEN
    RAISE EXCEPTION 'Predecessor 051_contacts_status_constraint_extend not applied';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS unmatched_inbound (
    id            BIGSERIAL PRIMARY KEY,
    -- RFC 2822 Message-ID of the inbound reply (unique — deduplication guard)
    message_id    TEXT        NOT NULL,
    -- In-Reply-To header value (may be empty if sender stripped headers)
    in_reply_to   TEXT        NOT NULL DEFAULT '',
    -- Raw From: header value (may include display name)
    from_address  TEXT        NOT NULL DEFAULT '',
    subject       TEXT        NOT NULL DEFAULT '',
    -- First 500 characters of plain-text body for quick operator triage
    body_preview  TEXT        NOT NULL DEFAULT '',
    -- When the message arrived in the IMAP mailbox
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set by operator after triage
    reviewed      BOOLEAN     NOT NULL DEFAULT FALSE,
    reviewed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup guard: if the same Message-ID arrives twice (e.g. poller restart),
-- parkUnattributed uses ON CONFLICT (message_id) DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS unmatched_inbound_message_id_idx
    ON unmatched_inbound (message_id);

-- Operator review queue: show newest unreviewed first.
CREATE INDEX IF NOT EXISTS unmatched_inbound_reviewed_received_idx
    ON unmatched_inbound (reviewed, received_at DESC)
    WHERE NOT reviewed;

-- Record migration (schema_migrations.version is text, no .sql extension)
INSERT INTO schema_migrations (version) VALUES ('053_unmatched_inbound')
    ON CONFLICT DO NOTHING;
