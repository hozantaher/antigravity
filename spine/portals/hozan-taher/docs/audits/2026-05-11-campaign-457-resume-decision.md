# Campaign 457 Resume Decision — 2026-05-11

## Campaign Meta

- **Name:** Strojírenství — výkup techniky první vlna
- **ID:** 457
- **Status:** running
- **Sequence:** 1-step (intro_machinery, 0-day delay)
- **Category:** prefix match
- **Created:** 2026-05-05, Active: 6 days

## Pool Breakdown

**Contact distribution:**
- Pending: 2
- Completed (sent): 40
- Skipped: 58
- **Total:** 100 enrolled contacts

**Last successful send:** 2026-05-09 21:24 UTC (39 hours ago)

## Skip Reasons (58 contacts)

| Reason | Count | Notes |
|--------|-------|-------|
| per_domain_cooldown | 35 | 180-day cooldown active on domains with prior sends |
| region_rate_limit | 21 | Regional throttling (CZ outbound context) |
| crm_active_client | 1 | Internal CRM client (bypass not applicable) |
| lifetime_exhausted | 1 | Sequence steps completed |

## Domain State (Top 10 by enrollment)

| Domain | Enrolled | Sent | Cooldown-Skip |
|--------|----------|------|---------------|
| sabata.cz | 14 | 2 | 8 |
| diamo.cz | 11 | 0 | 0 |
| adoz.cz | 8 | 1 | 4 |
| sprako.cz | 5 | 5 | 0 |
| seznam.cz | 5 | 2 | 1 |
| pmdp.cz | 4 | 0 | 0 |
| aros-stav.cz | 4 | 1 | 3 |
| uchytil.eu | 4 | 3 | 1 |
| vermax.cz | 3 | 0 | 0 |
| elco.cz | 3 | 1 | 2 |

**Key finding:** 6 domains (sabata, adoz, aros-stav, uchytil, dastra, elco) are partially throttled by cooldown. Many untouched domains (diamo, pmdp, vermax) remain available.

## Daemon State

Scheduler running healthy (~20–32ms per cycle). Last campaign-457 execution: 2026-05-11 12:50 UTC. Zero sends in past 36h confirms dedup wall.

## Options & Capacity

**Option A: Enroll fresh segment (RECOMMENDED)**
- Source: Stavby/strojírenství segment from main contacts table not yet enrolled
- Capacity: ~50–80 new contacts (untouched domains)
- Estimated throughput: 5–10 sends/day (region rate limit + mailbox capacity)
- Timeline: Immediate; daemon resumes on fresh enrollment
- Risk: Minimal — preserves anonymity ceiling, no provider reputation hit

**Option B: Loosen domain cooldown (180d → 90d)**
- Frees: ~35 currently-skipped contacts (sabata, adoz, aros-stav group)
- Estimated throughput: +8–12 sends/day
- Timeline: Immediate (config change)
- Risk: Same recipient in 90d window → provider replay detection; weakens contact freshness signal
- **Not recommended** for cold B2B email

**Option C: Wait for natural cooldown**
- All 35 cooldown-skipped contacts available in ~5 months
- Throughput: 0 (current pending=2 exhausted)
- Timeline: May–October
- Risk: Campaign intent expires; engagement cold
- **Not viable**

## Recommendation

**Implement Option A.** Operator should:

1. Identify untouched contact segment (e.g. next 60 stavby contacts from CRM import not yet in campaign 457)
2. Enroll via dashboard or SQL INSERT
3. Daemon auto-resumes sends within 1 polling cycle (~1 min)
4. Monitor throughput; adjust region_rate_limit thresholds if needed

This preserves campaign velocity, avoids provider reputation friction, and maintains anonymity ceiling for future campaigns.
