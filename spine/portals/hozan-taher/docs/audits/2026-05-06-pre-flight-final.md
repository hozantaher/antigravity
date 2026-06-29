# Pre-flight FINÁLNÍ — středa 6.5.2026, ostrý launch 8:00

**Status:** GREEN — clear for launch
**Datum check:** 2026-05-05 22:55 (večer před launch day)
**Session výstup:** 31 PRs merged, 630+ nových testů, 17 sekcí hardenovaných, 3 critical pre-launch enhancements (Pause All emergency, Analytics polling, Watchdog persistent snooze)

## 1. Campaign 457

| Field | Hodnota |
|---|---|
| ID | 457 |
| Název | Strojírenství — výkup techniky první vlna |
| Status | **draft** (operator klikne Aktivovat ráno) |
| Started_at | NULL |
| Timezone | Europe/Prague |
| Send window | 8:00 – 17:00 weekday |
| Daily cap per mailbox | 10 (= 40/day max přes 4 mailboxy) |

## 2. Campaign_contacts seed

| Status | Count |
|---|---|
| pending | **100** ✓ |

100 contacts seeded podle composite_score top-N (best lead first).

## 3. Mailboxy

| ID | Status | Last_score | Score_at | Circuit | Bounces |
|---|---|---|---|---|---|
| 1 | active | 100 | 2026-04-28 | closed | 0 |
| 3 | active | 100 | 2026-04-28 | closed | 0 |
| 631 | active | 100 | 2026-04-28 | closed | 0 |
| 632 | active | 100 | 2026-04-28 | closed | 0 |

## 4. Migrations stav

`schema_migrations` tracker:
- 048_suppression_list_status_sync ✓
- 049_dedup_guard ✓
- 050_crm_clients_import ✓
- 051_contacts_status_constraint_extend ✓
- 052_contacts_status_constraint_v2 ✓ (večerní backfill — replied_negative/positive/auto_reply)
- 053_unmatched_inbound ✓
- 054_imap_uidvalidity ✓

contacts_status_check constraint: 10 hodnot (valid/bounced/blacklisted/invalid/unsubscribed/suppressed/replied/replied_negative/replied_positive/auto_reply).

## 5. Anti-trace relay

```
GET /v1/status (authed) → 200
{
  "bridge_status": "ok",
  "delivery_mode": "outbound-smtp",
  "pending_envelopes": 0,
  "queue_depth": 0,
  "uptime_seconds": 112 439  (~31 hodin)
}
```

## 6. Go orchestrator

```
GET /health (authed) → 200
{
  "status": "ok",
  "uptime_seconds": 604 085  (~7 dnů)
  "db": "ok",
  "daemons": [{campaign_daemon ok, last_run 2026-05-05 20:55}, ...]
}
```

## 7. Dedup-guard 8 axes

| # | Axis | Status |
|---|---|---|
| 1 | dnt_set | ✓ |
| 2 | lifetime_exhausted | ✓ |
| 3 | cross_campaign_cooldown | ✓ |
| 4 | per_domain_cooldown | ✓ |
| 5 | bounce_cluster | ✓ |
| 6 | region_rate_limit | ✓ |
| 7 | engagement_decay | ✓ |
| 8 | crm_active_client | ✓ |

## 8. /api/launch-readiness

```
GET /api/launch-readiness?campaign_id=457&segment_id=7 → 200
{
  "verdict": "green",
  "action_items": [],
  "sections": {
    "crm_coverage": {total: 45 855, blocked: 1 467, available: 44 388, blocked_pct: 3.2, traffic_light: "green"},
    "dedup_guard": {migration_applied: true, recent_activity_7d: true, operational: true},
    "mailboxes": {active: 4, paused: 0, bouncehold: 0},
    "sanity_gates": {total: 3, pass_count: 3, gates: [
      "Active mailboxes (4)" ✓,
      "Eligible contacts (100)" ✓,
      "Template valid" ✓
    ]},
    "recent_audit": [...]
  }
}
```

## 9. Preflight-only POST /api/campaigns/457/run

```
POST /api/campaigns/457/run (header X-Preflight-Only: 1) → 200
{
  "ok": true,
  "preflight_only": true,
  "blockers": [],
  "summary": {
    "mailboxes": 4,
    "mailboxes_valid": 4,
    "mailboxes_active": 4,
    "eligible_contacts": 100,
    "pre_enqueued_contacts": 100
  }
}
```

0 blockers. Ready.

## 10. verify-launch.mjs end-to-end

```
node scripts/verify-launch.mjs --campaign-id=457 --json → exit 0
```

5/5 steps pass:
- Step 1 (egress sanity): transport_mode=wgpool, wireproxy active, IP 146.70.129.110 (Mullvad CZ)
- Step 2 (BFF preflight): HTTP 200
- Step 3 (SMTP probe): 4 active mailboxes probed OK
- Step 4 (template render): "intro_machinery" rendered clean for 5 sample contacts — GDPR footer + UnsubURL OK
- Step 5 (DB write probe): skipped (read-only mode)

## Operator akce ráno 8:00

1. **Hard-refresh browseru** (Cmd+Shift+R) — nahraje fresh JS bundle s 31 PRs hardening polish
2. **Otevřít** `/launch-readiness?campaign_id=457&segment_id=7`
3. **Verify** verdict=green, 3/3 sanity gates pass, action_items=[]
4. **Klik Aktivovat** na campaign 457 (status=draft → running)
5. Sledovat per Fáze 1-5 plánu v `docs/initiatives/2026-05-06-mvp-launch-day.md`

## Halt protokol (kdyby šlo cokoli špatně)

**Emergency Pause All button** je dostupný:
- V topbar header (StopCircle ikona, vždy viditelný kdekoliv v dashboard) — z PR #941
- V Campaigns toolbar ("Pozastavit vše" tlačítko)
- BFF endpoint POST /api/campaigns/pause-all — transactional, audit per campaign

Jednoklik halt všech running campaigns + audit log.

## Co Claude přebírá zítra během dne

| Čas | Akce |
|---|---|
| 8:30 | Verify aktivace proběhla (campaign 457 status=running) |
| 9:00 | Daily_cap ramp 1 → 2 (Fáze 2) — UPDATE campaigns SET sending_config |
| 11:00 | Daily_cap ramp 2 → 5 (Fáze 3) |
| 14:00 | Daily_cap ramp 5 → 10 (Fáze 4) |
| 17:00 | End-of-day report — bounce_events trend, reply rate, mailbox health |
| 17:00–19:00 | Day-2 plan based on metrics |

Per HARD RULE memory `feedback_campaign_send` — Claude tlačítka NESTISKNE autonomně. Operator iniciuje aktivaci. Claude monitor + ramp + report.

## Halt podmínky

- Hard bounce > 5% (Fáze 4 cap)
- Mailbox circuit breaker trip
- Anti-trace relay queue depth >100 nebo unhealthy
- Reply classifier accuracy <70% (post-launch metric)

## Final verdict

**🟢 GREEN — clear for launch tomorrow 6.5.2026 at 8:00.**

Repo je v top stavu po 31 PRs tonight. Operator stačí 1 klik na Aktivovat. Já zařizuji zbytek během dne.
