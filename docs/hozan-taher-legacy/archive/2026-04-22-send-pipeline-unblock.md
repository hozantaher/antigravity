**Status:** Archived
**Datum:** 2026-04-22
**Trigger:** Send pipeline unblocked (1st email delivered 2026-04-27); work closed in phase 0

# Send Pipeline Unblock

**Created:** 2026-04-22
**Owner:** tomas
**Kind:** focused sprint (P0 bottleneck)
**Supersedes:** task #68 (P0-4 Seznam app-passwords)

## Motivace

Kampaně neodesílají. Root cause: **4 Seznam mailboxy (mb=1, 3, 631, 632) mají v DB placeholder heslo `123p123p123p123`** místo skutečných Seznam credentials. SMTP AUTH vrací 535 5.7.8. Navíc circuit breaker je tripped na mb=1 a mb=3 (`status='paused'`), takže i po opravě hesla sender je přeskočí.

Diagnostika dokončena 2026-04-22 (tasky #96, #97, #98). Důsledek: **0 emailů odesláno prod**, kampaně stojí.

## Cíl

**První email odeslán přes anti-trace-relay do 48h** (Seznam → reálný recipient, delivery confirmed).

## Non-goals

- Nenasazovat nový SMTP provider (zůstáváme na Seznam pro tento sprint)
- Neřešit sender engine refactor (M3)
- Neoptimalizovat send rate / throughput

## Sprint struktura — 5 vln

### SEND-S0 — Diagnostika ✅ DONE (2026-04-22)

- [x] #96 SEND-1 Probe all 4 mailboxes + DB state
- [x] #97 SEND-2 Seznam docs research (2FA → app-password required)
- [x] #98 SEND-3 Pipeline audit (circuit/status/bounce_hold/window/warmup)

**Zjištění:** DB placeholder hesla, 2/4 mailboxy paused, 0 reálných app-passwords dodaných.

### SEND-S1 — Real credentials do DB (1-2 dny)

Doplnit skutečná Seznam hesla (app-password nebo login-password podle 2FA stavu).

| ID | Task | Blocker? |
|---|---|---|
| S1.1 | Per mailbox: ověřit zda je 2FA zapnuto na Seznam účtu (manuálně přes webmail Account → Security) | user action |
| S1.2 | Pro 2FA-enabled: generovat "heslo pro aplikace" v Seznam Account panelu | user action |
| S1.3 | Pro 2FA-disabled: použít login password | user action |
| S1.4 | Zapsat credentials do DB přes dashboard UI (`http://localhost:5175` → Mailboxy → [schránka] → heslo) | user action |
| S1.5 | Verify DB: hex password nesmí matchovat placeholder `313233703132337031323370313233` (`123p123p123p123`) | assert SQL |

**Exit criteria:** DB obsahuje skutečná hesla pro všechny 4 mailboxy; žádný placeholder.

### SEND-S2 — AUTH probe + circuit reset (1h)

| ID | Task | TDD |
|---|---|---|
| S2.1 | Probe each mailbox via prod relay `/v1/auth-check` s novým heslem. Expect `ok=true`, steps smtp_auth OK | test-first: assert ok=true |
| S2.2 | Pokud ok → reset circuit + status: `UPDATE outreach_mailboxes SET status='active', circuit_opened_at=NULL, consecutive_bounces=0, auth_fail_count=0, status_reason=NULL WHERE id IN (1,3,631,632)` | verify via SELECT |
| S2.3 | Pokud fail → diagnose (log steps), nenaskakovat na S3 | |

**Exit criteria:** 4/4 mailboxů `ok=true` v auth-check, DB status='active'.

### SEND-S3 — E2E send test (2-4h)

Ověřit že jeden email opravdu doletí.

| ID | Task | Test type |
|---|---|---|
| S3.1 | Poslat test email přes každý mailbox na vlastní adresu (self-send) přes relay `/submit` endpoint | E2E manual |
| S3.2 | Ověřit doručení v Seznam Inbox (webmail) | manual |
| S3.3 | Monitor `watchdog_events` table — žádné circuit tripping v S3.1+5min | integration |
| S3.4 | Check Grafana dashboard / logs — žádné 4xx/5xx v relay audit log | observability |

**Exit criteria:** 4/4 self-send emails landed, 0 watchdog alerts, 0 relay errors.

### SEND-S4 — Send window + warmup config (2h)

Pre-empt další bottlenecky před spuštěním kampaně.

| ID | Task |
|---|---|
| S4.1 | Ověřit `SENDING_WINDOW_START/END` env vars na machinery-outreach + timezone `SENDING_TIMEZONE` |
| S4.2 | Check `mailbox_warmup.warmup_day` pro každý mb — pokud 1, limit 10/den. Rozhodnout: bump na 30 pro prod (pokud accounts už prewarmed) nebo nechat ramp |
| S4.3 | Check `daily_cap_override` — nejsou nastaveny na 0? |
| S4.4 | Verify Czech kalendář aktivní pro dnes (není svátek/víkend) |

**Exit criteria:** config dokumentován v `docs/playbooks/SEND-OPERATIONS.md`, žádná surprise blokace.

### SEND-S5 — First campaign (1 den)

První skutečná kampaň do reálných recipientů.

| ID | Task |
|---|---|
| S5.1 | Zvolit pilotní kampaň v dashboardu (draft nebo nová), <= 10 contacts |
| S5.2 | Spustit přes dashboard Campaigns page |
| S5.3 | Monitor live: dashboard `/api/jobs`, watchdog events, mailbox health |
| S5.4 | Po 24h: review stats (delivered/bounced/replied), rozhodnout scale up |

**Exit criteria:** ≥5 emails delivered, bounce rate ≤ 5%, 0 circuit trips.

### SEND-S6 — Disciplinární guardrails (ongoing)

Aby se to neopakovalo.

| ID | Task |
|---|---|
| S6.1 | Test: `tests/invariant/no_placeholder_passwords.sql` — CI assert že žádný mailbox nemá placeholder heslo |
| S6.2 | Dashboard indicator: červený badge na mailbox card pokud `password IS NULL OR length(password) < 10 OR password LIKE '123p%'` |
| S6.3 | Alert wiring: watchdog event "mailbox AUTH fail 3× in 15min" → Slack/email notification |
| S6.4 | Memory rule: "mailbox hesla VŽDY přes dashboard UI nebo SQL UPDATE, NIKDY env vars po bootstrap" |
| S6.5 | Runbook: `docs/playbooks/MAILBOX-PASSWORD-UPDATE.md` — jak nastavit/rotovat app-password pro novou Seznam schránku |

**Exit criteria:** CI failne při placeholder heslu; UI ukazuje missing-password mailboxy; runbook committed.

## Timeline

```
Den 1   S1 user action (2FA check + app-password gen + DB update)  [~2h user work]
         S2 probe + circuit reset                                    [30 min]
Den 1   S3 E2E self-send verify                                      [2-4 h]
         S4 window + warmup config                                   [1 h]
Den 2   S5 pilot kampaň start                                        [2 h + 24h wait]
Den 3   S5 review + scale decision                                   [1 h]
Den 3-7 S6 guardrails                                                [ongoing]
```

**Critical path:** S1 user action → S2 → S3 → S5.

## Rozhodnutí potřebná hned

1. **Per mailbox: 2FA on/off?** Jediný způsob zjistit = loginnout do webmailu a zkontrolovat. Pokud user neví, předpoklad = OFF (default), heslo = main account password.
2. **Zrušit pokus "Banana3000"?** Pokud user změnil Seznam password na Banana3000 a účet má 2FA OFF → Banana3000 je správné heslo. Pokud 2FA ON → Banana3000 je login heslo, ne app-password, takže 535 smisl.

## Rozsah závislostí

- Závisí na: prod anti-trace-relay funguje (OK dle SEND-1 probe), prod DB dostupná (OK via Railway TCP proxy), local dashboard běží (OK teď).
- Blokováno: bez user action S1 sprinty S2-S5 nemohou start.

## Rollback

Pokud S3 fail / delivery neprojde:
- Pauza: `UPDATE outreach_mailboxes SET status='paused', status_reason='SEND-S3 failure' WHERE id IN (1,3,631,632)`
- Root cause analysis: logs z machinery-outreach + anti-trace-relay audit
- Možné alternativy: jiný SMTP provider (Fastmail SMTP bridge přes privacy-gateway), vlastní SMTP (postfix na VPS)

## Success metrics

Po 7 dnech od začátku S5:
- ✅ ≥ 100 emails odesláno
- ✅ bounce rate < 5%
- ✅ delivery rate > 90%
- ✅ 0 mailbox circuit trips
- ✅ 0 placeholder heslo v DB (CI guard aktivní)
- ✅ reply handling funguje (inbox tab ukazuje odpovědi)

## Odkazy

- Master initiative: `docs/initiatives/2026-04-22-discipline-and-domain-migration.md`
- Memory: `project_schrany_quality_debt.md`, `project_outreach_go_quality_debt.md`
- Hard rule: `feedback_no_direct_smtp.md` (žádné openssl/curl/nc direct na smtp.*, vše přes relay)
- Seznam docs: https://o-seznam.cz/napoveda/ucet/dvoufazove-overeni/postovni-programy/
