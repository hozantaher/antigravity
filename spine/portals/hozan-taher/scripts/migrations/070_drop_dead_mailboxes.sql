-- 070_drop_dead_mailboxes.sql
--
-- Sprint AQ1: drop nowak.gorak (id=12833) + goran.nowak (id=12834) mailboxes
-- declared dead 2026-05-08 after Seznam fraud-detection lock.
--
-- Both schránky byly založeny tentýž den (2026-05-08), použity pro testování
-- multi-country send (Mullvad pool BG/RO/SI/SK rotation pre-AN PR #1100) +
-- IMAP polling z localhost CZ residential IP. Seznam viděl 4-7 různých
-- (IP, country) tuples per account za 30 min → automatic fraud lock.
-- Account recovery není garantovaná; operator se rozhodl restart from
-- scratch s hardened-from-day-0 setup (Sprints AO + AP + AQ).
--
-- CASCADE handles:
--   - mailbox_check_cache (FK CASCADE)
--   - mailbox_check_history (FK CASCADE)
--   - mailbox_imap_state (FK CASCADE)
--   - mailbox_imap_circuit (FK CASCADE)
--   - mailbox_alerts (FK CASCADE)
--   - mailbox_cooldown_log (FK CASCADE)
--   - mailbox_auth_fails (FK CASCADE)
--
-- SET NULL handles:
--   - leads.mailbox_id (FK SET NULL)
--   - suppression_list.mailbox_id (FK SET NULL)
--
-- Already executed at 2026-05-08T13:50Z out-of-band; this migration locks
-- the change in schema_migrations for predecessor-ordering integrity.
--
-- Predecessor: 069_mailbox_egress_pin.sql (Sprint AP2 not yet shipped —
-- planned predecessor; reorder if AP2 lands separately).

BEGIN;

DELETE FROM outreach_mailboxes WHERE id IN (12833, 12834);

INSERT INTO schema_migrations (version)
VALUES ('070_drop_dead_mailboxes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
