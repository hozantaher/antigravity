# Scenario Seed — Pre-launch UI Walkthrough Fixtures

Synthetic fixtures for pre-launch operator review. All data uses `@seed.local` email domains and is clearly marked as demo data. **Never commit these rows to a campaign that sends real emails.**

## Apply

```bash
export DATABASE_URL=<your-db-url>
psql "$DATABASE_URL" -f scripts/scenario/seed-scenario.sql
```

## Verify

```sql
SELECT table_name, count FROM (
  SELECT 'contacts'        AS table_name, COUNT(*) AS count FROM contacts WHERE email LIKE '%@seed.local'
  UNION ALL
  SELECT 'outreach_contacts', COUNT(*) FROM outreach_contacts WHERE email LIKE '%@seed.local'
  UNION ALL
  SELECT 'leads'           , COUNT(*) FROM leads WHERE contact_id IN (SELECT id FROM contacts WHERE email LIKE '%@seed.local')
  UNION ALL
  SELECT 'outreach_threads', COUNT(*) FROM outreach_threads WHERE campaign_id = (SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%')
  UNION ALL
  SELECT 'reply_inbox'     , COUNT(*) FROM reply_inbox WHERE campaign_id=(SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%')
  UNION ALL
  SELECT 'bounce_events'   , COUNT(*) FROM bounce_events WHERE send_event_id IN (SELECT id FROM send_events WHERE campaign_id=(SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%'))
  UNION ALL
  SELECT 'send_events'     , COUNT(*) FROM send_events WHERE campaign_id=(SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%')
  UNION ALL
  SELECT 'tracking_open'   , COUNT(*) FROM tracking_events WHERE send_event_id IN (SELECT id FROM send_events WHERE campaign_id=(SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%')) AND event_type='open'
  UNION ALL
  SELECT 'tracking_click'  , COUNT(*) FROM tracking_events WHERE send_event_id IN (SELECT id FROM send_events WHERE campaign_id=(SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%')) AND event_type='click'
  UNION ALL
  SELECT 'watchdog'        , COUNT(*) FROM watchdog_events WHERE metadata @> '{"scenario":true}'
  UNION ALL
  SELECT 'cc_skipped'      , COUNT(*) FROM campaign_contacts WHERE campaign_id=(SELECT id FROM campaigns WHERE name LIKE '[SCENARIO]%') AND status='skipped'
) t ORDER BY table_name;
```

**Expected counts (post-apply):**

| Table | Expected |
|---|---|
| contacts | 50 |
| outreach_contacts | 20 |
| leads | 20 (8 qualifying, 5 demo, 4 proposal, 2 won, 1 lost) |
| outreach_threads | 20 |
| reply_inbox | 20 |
| bounce_events | 30 (20 hard + 10 soft) |
| send_events | 230 (200 analytics + 30 bounce-seed) |
| tracking_open | 50 |
| tracking_click | 24 |
| watchdog | 10 (3 critical, 4 warning, 3 info) |
| cc_skipped | 16 (2 per dedup axis × 8 axes) |

## Cleanup

```bash
psql "$DATABASE_URL" -f scripts/scenario/cleanup-scenario-seed.sql
```

Run the verify query above again — all counts should be 0.

## Markers used

- `contacts.email LIKE '%@seed.local'`
- `outreach_contacts.email LIKE '%@seed.local'`
- `campaigns.name LIKE '[SCENARIO]%'`
- `watchdog_events.metadata @> '{"scenario":true}'`
- `outreach_messages.message_id LIKE 'scen-%'`

## What each section covers

| Section | Data | Dashboard pages covered |
|---|---|---|
| A — Leads | 20 leads across kanban stages | /leads, /pipeline |
| B — Replies | 50 inbound messages + reply_inbox | /replies, /inbox |
| C — Bounce events | 30 bounces (3 ICO clusters) | /bounces, /mailbox health |
| D — Send + tracking | 200 sends, 79 tracking events | /analytics, /campaigns |
| E — Watchdog | 10 alerts (critical/warning/info) | /watchdog, /monitoring |
| F — Dedup guard | 16 skips (all 8 axes) | /dedup-guard |

## Safety constraints

- Campaign ID 457 (real seeds) is NOT touched
- Segment 7 is NOT touched
- `campaign_contacts` only has rows for the `[SCENARIO]` campaign
- All emails use `@seed.local` or `@demo.invalid` — obvious fakes
