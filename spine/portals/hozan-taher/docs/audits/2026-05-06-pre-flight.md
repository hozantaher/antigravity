# Pre-flight check — 6.5.2026 launch day

**Status:** GREEN — clear for launch (čeká na operator activation 8:00)
**Datum check:** 2026-05-05 16:00 (večerní pre-flight, den před launchem)

## 1. Segment kvalita

| Metrika | Hodnota | Verdict |
|---|---|---|
| Companies v segment #7 | 45 855 | ✓ |
| Eligible po všech filtrech | **44 825** | ✓ |
| Filtered out (suppression ∪ CRM ∪ datum_zaniku) | 1 030 | ✓ |
| email_status='valid' | 100% (45 855/45 855) | ✓ |
| email_verification.detail='verified' | 100% | ✓ |
| risk_level='low' | 100% | ✓ |
| mx_exists=true | 100% | ✓ |
| is_role / is_disposable / is_spamtrap | 0 / 0 / 0 | ✓ |
| Companies s DNT contactem | 0 | ✓ |
| Composite_score min/avg/max | 14.0 / 36.3 / 50.0 | ⚠ note |
| Score >= 50 (top tier) | 58 firm | ✓ pro Day-1 |

⚠ Note: composite_score max je 50, ne 70+. Tohle je B2B firmy.cz-scraped data — vyšší skóry se dostávají enrichmentem (ICP, intent signals), kterého tento segment nezískal. **Neblokující** — 58 firm @ score>=50 je dost pro 40-mail Day-1 wave.

## 2. Mailbox readiness

| ID | Status | Last_score | Score_at | Circuit_open | Trips | Bounces |
|---|---|---|---|---|---|---|
| 1 | active | 100 | 2026-04-28 | NULL | 0 | 0 |
| 3 | active | 100 | 2026-04-28 | NULL | 0 | 0 |
| 631 | active | 100 | 2026-04-28 | NULL | 0 | 0 |
| 632 | active | 100 | 2026-04-28 | NULL | 0 | 0 |

Všechny 4 mailboxy active, password set, score 100, zero bounces, circuit closed. ✓

## 3. Anti-trace relay

```
GET /v1/status (authed)
→ 200 OK
{
  "bridge_status": "ok",
  "delivery_mode": "outbound-smtp",
  "pending_envelopes": 0,
  "queue_depth": 0,
  "uptime_seconds": 91672
}
```

Queue empty, bridge healthy, ~25h uptime. ✓

## 4. Schema readiness

| Migrace | Status | Note |
|---|---|---|
| 049_dedup_guard | applied 2026-05-05 | contacts.dnt + lifetime_touches + email_domain |
| 050_crm_clients_import | applied 2026-05-05 | crm_clients + FK |
| 051_contacts_status_constraint_extend | applied 2026-05-05 | constraint allows suppressed+replied |
| 052_classifier_status_values | applied 2026-05-05 | replied_negative/positive/auto_reply |
| 048_suppression_list_status_sync | applied 2026-05-05 | mirror trigger active, 1767 backfilled |

`schema_migrations` table backfilled. Trigger `s11_mirror_suppression_list` active. ✓

## 5. Dedup-guard 8 axes

| # | Axis | Source | Status |
|---|---|---|---|
| 1 | dnt_set | contacts.dnt | ✓ wired |
| 2 | lifetime_exhausted | contacts.lifetime_touches >= 3 | ✓ |
| 3 | cross_campaign_cooldown | send_events 90d | ✓ |
| 4 | per_domain_cooldown | send_events 180d | ✓ |
| 5 | bounce_cluster | bounce_events 30% per IČO | ✓ (PR #832) |
| 6 | region_rate_limit | send_events 2/h per kraj | ✓ |
| 7 | engagement_decay | tracking_events 365d | ✓ |
| 8 | crm_active_client | crm_clients FK | ✓ |

CheckEligibility v `features/outreach/campaigns/sender/dedup_guard.go` má všech 8 axes (8 Reason values + eligible empty). ✓

## 6. Campaign 457 config

```json
{
  "timezone": "Europe/Prague",
  "send_window_days": [1, 2, 3, 4, 5],
  "send_window_start_hour": 8,
  "send_window_end_hour": 17,
  "daily_cap_per_mailbox": 10
}
```

Status: **draft** (čeká na operator activation). Maximum 40 mailů za den (4 mailboxy × 10).

## 7. Stack health

- Go orchestrator: live, uptime 6.7d, db ok, daemons running
- BFF (lokální dev): :18001 + :18175 up
- Test suites: campaigns 1630/1630, orchestrator 2010/2010, relay 1893/1893, dashboard 232 file passed

## Final verdict

**GREEN — clear for launch tomorrow 8:00.**

Žádné HALT podmínky. Všechny gating mechanismy (dedup-guard 8 axes, mailbox circuit breaker, daily_cap, send window, holiday calendar) operativní.

## Operator akce zítra ráno 8:00

1. Otevřít dashboard https://outreach.dashboard.local/launch-readiness?campaign_id=457&segment_id=7
2. Ověřit verdict (po seedu se z red změní na green-amber)
3. Tlačítko **Aktivovat** na Campaign 457
4. Sledovat per Fáze 1-4 plánu v `docs/initiatives/2026-05-06-mvp-launch-day.md`
