# Deep inventory testovací data v2 — středa 6.5.2026 01:00

**Status:** Update post scenario seed (PR #950)
**Trigger:** Operator zopakoval otázku po aplikaci scenario fixtures.

## Changelog vs v1 (00:30)

| Table | v1 | v2 | Delta | Source |
|---|---|---|---|---|
| campaigns | 1 | 2 | +1 | scenario campaign `[SCENARIO]` |
| contacts | 524 523 | 524 573 | +50 | `@seed.local` fake emails |
| outreach_contacts | 524 519 | 524 539 | +20 | scenario subset |
| campaign_contacts | 100 | 116 | +16 | scenario skip rows (8 axes) |
| send_events | 0 | 230 | **+230** | scenario campaign sends 7-day backfill |
| tracking_events | 0 | 79 | **+79** | scenario open/click/reply pixels |
| reply_inbox | 0 | 20 | **+20** | scenario inbound replies |
| outreach_messages | 252 | 292 | +40 | scenario inbound (via outreach_threads) |
| outreach_threads | 193 | 213 | +20 | scenario threads |
| leads | 0 | 20 | **+20** | scenario leads (5 stages) |
| bounce_events | 0 | 30 | **+30** | 20 hard + 10 soft |
| watchdog_events | 22 494* | 22 494 | 0 | (already populated; +10 scenario in metadata) |

\* watchdog_events table existed before — má 22k řádků z protections monitoring (běží od 2026-04-21 per migrace 041). 10 scenario alerts má `metadata @> '{"scenario":true}'`.

## Aktuální celý stav DB (po scenario seed)

| Table | Rows | Klasifikace |
|---|---|---|
| companies | 1 087 178 | PROD scrape (firmy.cz + ARES) |
| contacts | **524 573** | 524 523 PROD + 50 scenario |
| outreach_contacts | 524 539 | 524 519 PROD + 20 scenario |
| segment_memberships | 45 855 | PROD |
| crm_clients | 4 079 | PROD eWAY-CRM import |
| suppression_list | 1 745 | 1 728 auto + 17 manual |
| send_events | **230** | scenario only (žádné production sendy) |
| outreach_messages | **292** | 252 anonymity-test + 40 scenario inbound |
| outreach_threads | **213** | 193 anonymity-test + 20 scenario |
| outreach_mailboxes | 4 | PROD |
| email_templates | 6 | 3 PROD + 3 test orphan |
| campaign_contacts | **116** | 100 production seed + 16 scenario skips |
| operator_audit_log | 38+ | session activity |
| anonymity_test_messages | 17 | brutal e2e PR #885 results |
| outreach_suppressions | 17 | manual |
| **leads** | **20** | scenario only |
| **bounce_events** | **30** | scenario only |
| **reply_inbox** | **20** | scenario only |
| **tracking_events** | **79** | scenario only |
| **watchdog_events** | **22 494** | mostly real protections + 10 scenario marker |
| campaigns | 2 | 1 PROD draft (#457) + 1 scenario completed |
| segments | 1 | PROD |
| unmatched_inbound | 0 | empty |

## Scenario marker counts (verified)

| Marker | Count | Tabulka |
|---|---|---|
| `email LIKE '%@seed.local'` | 50 | contacts |
| `email LIKE '%@seed.local'` | 20 | outreach_contacts |
| `name LIKE '[SCENARIO]%'` | 1 | campaigns |
| `from_email LIKE '%@seed.local'` | 20 | reply_inbox |
| `contact_id IN (scenario contacts)` | 20 | leads |
| `contact_id IN (scenario contacts)` | 30 | bounce_events |
| `campaign_id = scenario campaign` | 230 | send_events |
| `send_event_id IN (scenario)` | 79 | tracking_events |
| `metadata @> '{"scenario":true}'` | 10 | watchdog_events |

**Total scenario rows:** 460 (50 contacts + 20 oc + 1 camp + 20 reply + 20 leads + 30 bounce + 230 send + 79 tracking + 10 watchdog)

## Production-feel vs test-feel verdict (v2)

| Layer | Verdict |
|---|---|
| companies (1.08M) | PROD scrape, < 0.1% test-named |
| contacts (524k) | **524 523 PROD + 50 scenario** (0.01%) |
| crm_clients (4k) | PROD eWAY-CRM import |
| suppression_list (1.7k) | PROD |
| outreach_mailboxes (4) | PROD Seznam accounts |
| outreach_messages (292) | 252 TEST RESIDUAL + 40 scenario fixtures |
| outreach_threads (213) | 193 TEST RESIDUAL + 20 scenario |
| anonymity_test_messages (17) | TEST RESIDUAL (brutal e2e) |
| email_templates | 3 PROD + 3 test orphan |
| campaigns | 1 PROD-pending + 1 scenario completed |
| segments | 1 PROD |
| campaign_contacts (116) | 100 PROD seed + 16 scenario skip rows |
| send_events (230) | **0 PROD + 230 scenario** |
| tracking_events (79) | **0 PROD + 79 scenario** |
| reply_inbox (20) | **0 PROD + 20 scenario** |
| leads (20) | **0 PROD + 20 scenario** |
| bounce_events (30) | **0 PROD + 30 scenario** |
| watchdog_events (22k) | 22 484 PROD monitoring + 10 scenario |

**Před scenario seed:** Leady, Replies, Send/Tracking, Bounce events všechny prázdné.
**Po scenario seed:** každá stránka má realistic data states, operator může projít UI demo.

## Cleanup procedure

Single-command revert (FK-safe order):
```bash
psql "$DATABASE_URL" -f scripts/scenario/cleanup-scenario-seed.sql
```

Markery k cleanup detection (greppable):
- `email LIKE '%@seed.local'` (50 contacts + 20 outreach_contacts)
- `name LIKE '[SCENARIO]%'` (1 campaign)
- `from_email LIKE '%@seed.local'` (20 reply_inbox)
- `metadata @> '{"scenario":true}'` (10 watchdog_events)

## Pre-launch state

| Critical path | Stav |
|---|---|
| campaign 457 | draft, started_at NULL, 100 contacts seeded — žádný scenario contamination |
| segment 7 | 45 855 firem, žádné scenario contacts |
| outreach_mailboxes | 4 production Seznam accounts, žádný test mailbox |
| send_events for campaign 457 | 0 (scenario je separate campaign) |
| /api/launch-readiness | verdict=green, 3/3 sanity gates pass |

**Scenario data je ISOLATED.** Launch path neporušen.

## Test fixtures v repu (no change od v1)

| Soubor | Účel |
|---|---|
| `features/inbound/orchestrator/mime/testdata/*.eml` (7) | MIME parser tests |
| `features/inbound/inbox/reply/testdata/adversarial/*.eml` (13) | Reply classifier robustness |
| `features/acquisition/contacts/internal/blockdetect/testdata/adversarial/*.txt` (~20) | WAF samples |
| `tests/fixtures/operator-replies/_placeholders/*.eml` (6) | Operator practice |
| `features/inbound/orchestrator/seed/*.go` | Go seed package |
| `scripts/migrations/006_seed_multi_mailbox_pool.sql` | Mailbox seed (legacy) |
| `scripts/migrations/008_seed_heavy_templates.sql` | Template seed |
| `scripts/launch/seed-campaign-457.sql` | **Pre-launch real seed** |
| `scripts/scenario/seed-scenario.sql` | **Synthetic UI demo seed (PR #950)** |
| `scripts/scenario/cleanup-scenario-seed.sql` | **Revert script (PR #950)** |
| `scripts/mail-lab/seed.sh` + `seed-replies.sh` | Mail-lab demo data |

## Operator runbook

**Před launch:**
1. Procházej dashboard sekce — vidíš realistic data states
2. Filtry, bulk actions, search, drill-downs — všechno demonstrable
3. Pokud najdeš UI bug → file issue

**Po úspěšném launch:**
```bash
# Wipe scenario data před prvním realistic operator usage
psql "$DATABASE_URL" -f scripts/scenario/cleanup-scenario-seed.sql
```

Cleanup je idempotentní + transactional. Po něm DB obsahuje jen production data + reálné campaign 457 metriky.
