-- ════════════════════════════════════════════════════════════════════════
-- Cross-mailbox Anonymity Test — S2 analytic table
-- ════════════════════════════════════════════════════════════════════════
--
-- Stores one row per inbound IMAP message harvested by the anonymity
-- harvest tool (cmd/anonymity-harvest). Scorers in S3/S4 read from this
-- table to compute per-direction anonymity and human-likeness scores.
--
-- Pairing key: test_run_id (from X-Test-Run-ID custom header) + from_addr
-- + receiver_mailbox_id. The (run_id, from, to) triple is unambiguous given
-- the 36-send test matrix has unique sender/receiver pairs per template.
--
-- Forward-compatibility:
--   - CREATE TABLE IF NOT EXISTS — idempotent re-runs
--   - UNIQUE (receiver_mailbox_id, imap_uid, imap_uidvalidity) — harvest
--     re-runs are idempotent; ON CONFLICT DO NOTHING in the harvester
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS anonymity_test_messages (
    id                   bigserial PRIMARY KEY,
    test_run_id          uuid NOT NULL,
    sender_mailbox_id    bigint NOT NULL REFERENCES outreach_mailboxes(id),
    receiver_mailbox_id  bigint NOT NULL REFERENCES outreach_mailboxes(id),
    template_name        text NOT NULL,
    send_event_id        bigint REFERENCES send_events(id),
    imap_uid             bigint NOT NULL,
    imap_uidvalidity     bigint NOT NULL,
    -- raw_headers: map of header-name → array of values (Received is multi-value)
    raw_headers          jsonb NOT NULL,
    raw_body             text NOT NULL,
    -- received_chain: Received headers in arrival order (most recent first = RFC 5321)
    received_chain       text[] NOT NULL DEFAULT '{}',
    message_id           text,
    from_addr            text,
    return_path          text,
    -- Authentication-Results sub-values; NULL when header absent or value missing
    dkim_result          text,
    spf_result           text,
    dmarc_result         text,
    harvested_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (receiver_mailbox_id, imap_uid, imap_uidvalidity)
);

COMMENT ON TABLE anonymity_test_messages IS
    'S2 harvest output — one row per inbound test e-mail. '
    'Paired to originating send_event via X-Test-Run-ID header + (from_addr, receiver_mailbox_id). '
    'Scorers (S3 anonymity, S4 human-likeness) read from this table.';

COMMENT ON COLUMN anonymity_test_messages.raw_headers IS
    'Full header map: {name: [val1, val2]}. Received is multi-value; stored in declared order (most recent first).';

COMMENT ON COLUMN anonymity_test_messages.dkim_result IS
    'Extracted from Authentication-Results header(s): dkim=<value>. NULL when header absent.';

COMMENT ON COLUMN anonymity_test_messages.spf_result IS
    'Extracted from Authentication-Results header(s): spf=<value>. NULL when header absent.';

COMMENT ON COLUMN anonymity_test_messages.dmarc_result IS
    'Extracted from Authentication-Results header(s): dmarc=<value>. NULL when header absent.';

CREATE INDEX IF NOT EXISTS idx_anon_test_messages_run
    ON anonymity_test_messages (test_run_id);

CREATE INDEX IF NOT EXISTS idx_anon_test_messages_pair
    ON anonymity_test_messages (sender_mailbox_id, receiver_mailbox_id, template_name);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DOWN — reverse the change
-- ════════════════════════════════════════════════════════════════════════
--
--   DROP INDEX IF EXISTS idx_anon_test_messages_pair;
--   DROP INDEX IF EXISTS idx_anon_test_messages_run;
--   DROP TABLE IF EXISTS anonymity_test_messages;
--
-- ════════════════════════════════════════════════════════════════════════

\echo ''
\echo '── S2: anonymity_test_messages table ready.'

-- LEDGER: EXEMPT pre-schema_migrations-table era; run.sh handles ledger insertion
