# MVP Launch Day — středa 6. května 2026

**Status:** Plánováno, čeká na operator activation 8:00
**Datum:** 2026-05-06 (středa, weekday — send window otevřený 8-17 Europe/Prague)
**Trigger:** Po dokončení adversarial sweep (PRs #810-#855) všech blokujících findings + 8/8 dedup axes operativních + deploy live je systém ready pro první ostrou kampaň proti segmentu #7.

## Předmluva

Plán pokrývá **celý zítřejší send window 8-17h** s rampou rozprostřenou tak, aby každá další vlna byla gated kvalitou předchozí. Bez stojového probe (`/v1/verify` je stub) — místo toho real-send staircase plní stejnou roli signálu.

## Konstanty

- **Campaign:** id=457, "Strojírenství — výkup techniky první vlna", status=draft
- **Segment:** id=7, 45 855 firem s email_status=valid
- **Eligible po suppression+CRM filtrech:** ≈45 077 firem
- **Mailboxy:** 1, 3, 631, 632 — všechny active, score=100, password set
- **Send window:** 08:00–17:00 Europe/Prague, Po-Pá
- **Daily cap per mailbox:** 10 (= 40 mails/den na 4 mailboxy maximum)
- **Sequence:** první step (initial outreach), follow-up steps zatím off

## Fáze 0 — Pre-flight (večer 5.5. nebo ráno 6.5. před 8:00)

Operator nebo Claude (autonomně) ověří před aktivací:

1. Top-20 podle composite_score nemají overlap se suppression/CRM/DNT
2. Top-20 mají email_verification.detail='verified' + risk_level='low'
3. Mailboxy 1+3+631+632 mají last_score=100 a žádný `bounce_hold` flag
4. Anti-trace relay /v1/status je `pending_envelopes=0, queue_depth=0`
5. Migration 049+050+051+052 jsou applied na PROD (verified earlier today)
6. Dedup-guard panel /api/dedup-guard/stats odpovídá 200, axes operational

Output: report do `docs/audits/2026-05-06-pre-flight.md` s GREEN/RED verdiktem.

**Halt podmínky:** kterýkoliv check fails → zastavit, audit, případně přesunout launch o den.

## Fáze 0.5 — Seed campaign_contacts (večer 5.5. nebo ráno 6.5. před 8:00)

`campaign_contacts` pro campaign 457 je aktuálně **prázdné**. Bez seedu runner najde nula contacts a launch-readiness verdict zůstane red kvůli "Eligible contacts (0)".

Skript: `scripts/launch/seed-campaign-457.sql` — naseeduje top 100 contacts (ranked podle company composite_score). 100 dává runner.go prostor pro soft-rejection cases (greylist, transient bounce); Day-1 cap 40 stejně omezuje skutečně poslané.

Operator execution:
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/launch/seed-campaign-457.sql
```

Skript je idempotentní (ON CONFLICT DO NOTHING). Re-run bezpečný. Vrací `seeded_count` na konci.

**Halt podmínka:** seeded_count < 40 → segment quality issue, audit composite_score distribution, případně rozšířit ranking criterion. Pre-flight `eligible_total=44 825` znamená že seed by měl naplno dosáhnout 100 řádků.

## Fáze 1 — 8:00–9:00: Pilot 1 mail

Operator klikne **Aktivovat** na campaign 457 v dashboard. Před tím:
- Nastaví `daily_cap_per_mailbox=1` (1 mail × 4 mailboxy = 4 max za den, ale ve skutečnosti runner pickne jen jeden contact bo MaxPerDomainDay=5 a začíná od top-1 by score)

Operator sleduje:
- 8:00–8:15: Aktivace, runner pickne první contact, render template, enqueue
- 8:15–8:30: Engine.Run dispatchne přes anti-trace relay
- 8:30–9:00: SOAK — 30 min na případný bounce (NDR od recipient MX přijde do ~5-15 min)

**Checkpoint 9:00:**
- `SELECT COUNT(*) FROM bounce_events WHERE campaign_id=457 AND created_at > '2026-05-06 08:00';`
- 0 → ✓ proceed Fáze 2
- 1 hard bounce → halt, audit segment kvalitu, neproceedovat

## Fáze 2 — 9:00–11:00: Pět mailů

Operator zvedne `daily_cap_per_mailbox=2` (= 8 max ale dedup-guard MaxPerDomainDay=5 omezí na 5 unique-domain).

- 9:00–10:30: 4 nové sendy distribuované přes 4 mailboxy
- 10:30–11:00: SOAK 30 min

**Checkpoint 11:00:**
- bounce_events count od 8:00
- 0/5 → ✓ proceed Fáze 3
- 1/5 (20%) → caution, audit který bounce, rozhodnout
- 2+/5 → halt

## Fáze 3 — 11:00–14:00: 20 mailů

`daily_cap_per_mailbox=5` (= 20 max). 

- 11:00–12:30: send burst rozprostřený přes Poisson timing (`PoissonMeanSeconds=120`)
- 12:30–13:30: lunch SOAK + observability check
- 13:30–14:00: classifier metriky pokud přišly nějaké early replies

**Checkpoint 14:00:**
- bounce_events 8:00–14:00 — target <10% rate (≤2/20)
- reply_inbox new entries — first signal LLM classifier accuracy
- mailbox circuit_breaker none tripped
- relay queue_depth back to 0

OK → ✓ proceed Fáze 4. Halt jinak.

## Fáze 4 — 14:00–17:00: Plný day cap (40 mailů)

`daily_cap_per_mailbox=10` (= 40 max). 

- 14:00–17:00: zbývajících ~20 sendů přes 3h
- 17:00 send window zavře, runner přestane dispatchovat

**Checkpoint 17:00 (závěrečný):**
- Total bounce_events 8:00-17:00 / total sends → bounce rate
- Target: <5% hard bounce rate
- Reply rate (otevřená/click/reply události)
- Anti-trace anonymity score per send (z `anonymity_test_messages` pokud probe běží)

## Fáze 5 — 17:00–19:00: Day-end review

Operator nebo Claude:
1. Generate end-of-day report `reports/launch/2026-05-06-day-1.md`
2. Aggregate metrics:
   - Total sent: X
   - Hard bounces: Y (Y/X = %)
   - Soft bounces / greylist: Z
   - Open rate: pixel triggers (pokud nějaké přišly do 2h od send)
   - Reply count: pokud nějaké early replies, klasifikace LLM
3. Sanity check: žádný mailbox ve `bounce_hold` status?
4. Sanity check: žádná firma blocked přes bounce_cluster axis (>30% IČO bounce rate)?
5. Day-2 plan: pokračovat, hold, nebo full launch (40+/den)

## Halt protokol (na kterékoli checkpointu)

Pokud halt podmínka:
1. Operator: nastavit campaigns.status='paused' v UI
2. Verify: runner zastaví do max 2 minut (status check every Nth enqueue)
3. Audit: `SELECT * FROM bounce_events WHERE campaign_id=457 ORDER BY created_at DESC LIMIT 20;`
4. Per-bounce diagnostika: 
   - 5xx mailbox-doesn't-exist → segment quality issue
   - 5xx domain-rejects → IP reputation problem (Mullvad CZ exit blocked by recipient)
   - 4xx greylisting → temporary, normal
   - timeout → MX unreachable (DNS issue, RBL block)
5. Operator rozhodne: continue, hold, rollback (ne-jediný — žádný send není reverzibilní, ale lze přidat hard suppression list pro afflicted contact)

## Rollback

Send je nereverzibilní — mail už přišel recipientu. Co JDE rollbacknout:
- `campaigns.status='paused'` zastaví další sendy
- Affected contacts přidat do suppression_list aby další pokus selhal
- Pokud bylo poslán mail s ošklivou content typo, zaslat opravu z téhož mailboxu

## Day-2+ plánování (po úspěšném Day-1)

Pokud Day-1 pass (bounce <5%, žádný HALT):
- Day-2: full daily_cap=10/mailbox = 40/day, žádná staircase navíc
- Day-3+: postupné navyšování pokud open rate + reply rate dobré
- Day-7: classifier accuracy audit (Sprint B2 PR #812 harness — operator labeluje 20 reply samples)
- Day-7: probability scorer recalibration (#77 H2)
- Synthetic probe activation (#76 H1) po T+24h

## Operator-only akce shrnutí

| Akce | Když | Příkaz |
|---|---|---|
| Seed campaign_contacts | večer 5.5. nebo ráno 6.5. | `psql ... -f scripts/launch/seed-campaign-457.sql` |
| Aktivace campaign 457 | 8:00 | dashboard "Aktivovat" tlačítko |
| Postupné zvyšování daily_cap | 9:00, 11:00, 14:00 | UPDATE campaigns SET sending_config |
| Pause | kdykoliv halt podmínka | dashboard "Pauza" tlačítko |
| End-of-day review | 17:00-19:00 | generate report |

Per HARD RULE memory `feedback_campaign_send` — Claude tyhle akce NEDĚLÁ autonomně, jen monitoruje + reportuje. Operator stiskne tlačítka.

## Reference

- `docs/playbooks/first-campaign-launch.md` — operator runbook s konkrétními SQL příkazy
- `docs/subsystem-maps/anti-trace.md` — 42-step pipeline kontext
- `features/outreach/campaigns/campaign/runner.go` — per-tick orchestrace
- `features/outreach/campaigns/campaign/staircase.go` — staircase logika (column zatím nepřipojena)
- Memory `project_first_campaign_launch` — staircase rationale
- Memory `feedback_campaign_send` — HARD RULE: send jen na explicit operator consent
