-- =============================================================================
-- cleanup-scenario-seed.sql — Revert all synthetic scenario fixtures
-- =============================================================================
-- Apply:  psql "$DATABASE_URL" -f scripts/scenario/cleanup-scenario-seed.sql
--
-- Removes ALL rows seeded by seed-scenario.sql.
-- Greppable markers used for deletion:
--   - contacts.email LIKE '%@seed.local'
--   - campaigns.name LIKE '[SCENARIO]%'
--   - watchdog_events.metadata @> '{"scenario":true}'
--
-- Deletes in FK-safe reverse order.
-- =============================================================================

BEGIN;

-- 1. tracking_events → FK: send_events.id
DELETE FROM tracking_events
WHERE send_event_id IN (
    SELECT se.id FROM send_events se
    WHERE se.campaign_id IN (SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%')
);

-- 2. bounce_events → FK: send_events.id + contacts.id
DELETE FROM bounce_events
WHERE send_event_id IN (
    SELECT se.id FROM send_events se
    WHERE se.campaign_id IN (SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%')
);

-- 3. reply_inbox (rows without send_event_id — by campaign + contact)
DELETE FROM reply_inbox
WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%');

-- Also cleanup reply_inbox rows with @seed.local from_email
DELETE FROM reply_inbox
WHERE from_email LIKE '%@seed.local';

-- 4. send_events → FK: campaigns.id
DELETE FROM send_events
WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%');

-- 5. outreach_messages (inbound replies + outbound) via threads
DELETE FROM outreach_messages
WHERE thread_id IN (
    SELECT ot.id FROM outreach_threads ot
    WHERE ot.campaign_id IN (SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%')
);

-- Also cleanup by message_id prefix for safety
DELETE FROM outreach_messages
WHERE message_id LIKE 'scen-%';

-- 6. outreach_threads
DELETE FROM outreach_threads
WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%');

-- 7. campaign_contacts
DELETE FROM campaign_contacts
WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%');

-- 8. leads → FK: contacts.id
DELETE FROM leads
WHERE contact_id IN (SELECT id FROM contacts WHERE email LIKE '%@seed.local');

-- 9. watchdog_events (scenario marker in metadata)
DELETE FROM watchdog_events
WHERE metadata @> '{"scenario":true}'::jsonb;

-- 10. campaigns
DELETE FROM campaigns WHERE name LIKE '[SCENARIO]%';

-- 11. contacts (seed.local emails — final, after all FKs cleared)
DELETE FROM contacts WHERE email LIKE '%@seed.local';

COMMIT;

-- Verification (run manually after cleanup):
-- SELECT COUNT(*) FROM contacts WHERE email LIKE '%@seed.local';           -- expect 0
-- SELECT COUNT(*) FROM campaigns WHERE name LIKE '[SCENARIO]%';            -- expect 0
-- SELECT COUNT(*) FROM leads WHERE notes LIKE '%scenario-seed%';           -- expect 0
-- SELECT COUNT(*) FROM watchdog_events WHERE metadata @> '{"scenario":true}'; -- expect 0
