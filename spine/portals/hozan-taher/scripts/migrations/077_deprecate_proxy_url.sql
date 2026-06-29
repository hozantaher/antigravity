-- Migration 077: deprecate outreach_mailboxes.proxy_url column
--
-- Sprint AO6 (2026-05-08): smtpSend now routes exclusively via anti-trace-relay
-- /v1/submit. The per-mailbox proxy_url column is no longer read in any send path.
-- Relay selects wgpool endpoint based on mailbox_id + preferred_country.
--
-- The column is retained (not dropped) to:
--   a) preserve existing data in case rollback is needed
--   b) avoid table rewrite on large tables
--
-- To drop the column in a future migration after verifying no consumers remain:
--   ALTER TABLE outreach_mailboxes DROP COLUMN proxy_url;

BEGIN;

COMMENT ON COLUMN outreach_mailboxes.proxy_url IS
  'DEPRECATED 2026-05-08 (AO6/PR #AO6): legacy per-mailbox SOCKS5 proxy URL. '
  'Routing now managed by anti-trace-relay via wgpool (mailbox_id + preferred_country). '
  'Column kept for rollback safety; will be dropped in a future migration.';

INSERT INTO schema_migrations (version) VALUES ('077_deprecate_proxy_url') ON CONFLICT DO NOTHING;

COMMIT;
