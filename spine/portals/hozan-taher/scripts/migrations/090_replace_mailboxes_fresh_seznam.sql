-- 090_replace_mailboxes_fresh_seznam.sql
--
-- Operator decision (2026-05-09): drop all existing mailboxes (11583, 12834,
-- 13560, 13561) and insert 2 fresh @seznam.cz mailboxes with CZ Mullvad
-- endpoint pins. Reasons:
--   1. 12834 (goran.nowak@email.cz) má 1 fraud-lock event v historii (2026-05-08).
--      Fresh accounts mají čistší start.
--   2. 13560+13561 (mazher.a@*) jsou legacy z env-var era, neaktivně používané.
--   3. 11583 je e2e fixture (env='test') už pause-d.
--   4. cz-prg-wg-103 v DB byl orphan pin (relay pool nemá tento label) —
--      cleanup se odstranil přirozeně přes DELETE.
--
-- Po této migraci:
--   - 2 production mailboxů: nowak.goran@seznam.cz + goran.nowak@seznam.cz
--   - Pinned na cz-prg-wg-101 + cz-prg-wg-102 (real labels v relay pool)
--   - Status='active', lifecycle_phase='warmup_d0' (cap 5/d enforced)
--   - preferred_country='CZ'
--
-- Hesla: passed přes psql -v var=value (NIKDY inline v SQL)

BEGIN;

-- Drop existing — CASCADE handles mailbox_check_history, mailbox_op_rate_log,
-- mailbox_auth_fails, mailbox_imap_state, mailbox_imap_circuit, mailbox_alerts,
-- mailbox_cooldown_log per FK constraints. leads + suppression_list FKs SET NULL.
DELETE FROM outreach_mailboxes WHERE id IN (11583, 12834, 13560, 13561);

-- Insert 2 fresh @seznam.cz mailboxů.
-- Password passed via psql variable :pw (set via -v pw=...).
INSERT INTO outreach_mailboxes (
  from_address, display_name, sender_name,
  smtp_host, smtp_port, smtp_username, password,
  imap_host, imap_port, imap_username,
  environment, preferred_country, lifecycle_phase, status,
  pinned_endpoint_label, pinned_endpoint_at, pinned_endpoint_by
) VALUES
  ('nowak.goran@seznam.cz', 'Nowak Goran', 'Nowak Goran',
   'smtp.seznam.cz', 587, 'nowak.goran@seznam.cz', :'pw',
   'imap.seznam.cz', 993, 'nowak.goran@seznam.cz',
   'production', 'CZ', 'warmup_d0', 'active',
   'cz-prg-wg-101', NOW(), 'migration_090'),
  ('goran.nowak@seznam.cz', 'Goran Nowak', 'Goran Nowak',
   'smtp.seznam.cz', 587, 'goran.nowak@seznam.cz', :'pw',
   'imap.seznam.cz', 993, 'goran.nowak@seznam.cz',
   'production', 'CZ', 'warmup_d0', 'active',
   'cz-prg-wg-102', NOW(), 'migration_090');

INSERT INTO schema_migrations (version) VALUES ('090_replace_mailboxes_fresh_seznam') ON CONFLICT DO NOTHING;
COMMIT;
