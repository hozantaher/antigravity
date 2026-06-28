# SEND-OPERATIONS — operátorský runbook

Tento playbook pokrývá **všechny non-auth blokery** send pipeline v `modules/outreach`. Pro AUTH/heslové problémy viz [`MAILBOX-PASSWORD-UPDATE.md`](./MAILBOX-PASSWORD-UPDATE.md).

Stav k `2026-04-22` (středa, **sendable day** — není víkend ani český svátek).

---

## 1. Send window

**Kód:** `modules/outreach/internal/sender/engine.go:270-278` + `modules/outreach/internal/config/config.go:154-156,213`.

| Env var | Default | Prod (Railway) |
|---|---|---|
| `SENDING_WINDOW_START` | `8` | `8` |
| `SENDING_WINDOW_END` | `17` | `17` |
| `SENDING_TIMEZONE` | `Europe/Prague` | *(nenastaveno → default)* |
| `SENDING_MIN_DELAY_SECONDS` | `45` | `45` |
| `SENDING_MAX_DELAY_SECONDS` | `180` | `180` |

Logika: pokud `hour < WindowStart || hour >= WindowEnd` → sender spí 1 min a retryuje. Mimo okno fronta čeká, nic se neztrácí.

**Změna okna:** `railway variables --service machinery-outreach --set "SENDING_WINDOW_START=9"` → redeploy není třeba, engine čte z configu při startu workeru (po `restart`).

---

## 2. Warmup ramp

**Kód:** `modules/outreach/internal/warmup/plan.go` + `modules/outreach/configs/warmup.yaml`. Plán `default_30d` (aktivní pro všechny 4 Seznam schránky):

| warmup_day | daily_limit |
|---|---|
| 1 | 10 |
| 5 | 50 |
| 7 | 75 |
| 14 | 150 |
| 30 (warm) | 400 |

**Aktuální stav (Railway DB):**

| mailbox | warmup_day | limit | is_paused | status |
|---|---|---|---|---|
| `mazher.a@email.cz` | 1 | 10 | true | paused (3 SMTP failures) |
| `a.mazher@email.cz` | 2 | 20 | false | paused (3 SMTP failures) |
| `b.maarek@email.cz` | 15 | 150 | false | active |
| `maarek.b@email.cz` | 15 | 150 | false | active |

**Advance ramp** (denní cron): `go run ./cmd/warmup-daemon tick` — zvýší `warmup_day += 1` pro každou non-paused schránku, jejíž plán ještě neskončil.

**Reset schránky** (po incidentu, ekvivalent restartu warmupu):
```sql
UPDATE mailbox_warmup SET warmup_day = 0, is_paused = false, pause_reason = NULL
WHERE mailbox_address = 'X@email.cz';
```

**Bump warmup_day manuálně** (když víme, že reputace je už teplá):
```sql
UPDATE mailbox_warmup SET warmup_day = 14 WHERE mailbox_address = 'X@email.cz';
```

---

## 3. Daily cap (`outreach_mailboxes.daily_cap_override`)

**Kód:** `modules/outreach/internal/mailbox/mailbox.go:73,126`. `NULL` → efektivní limit = warmup plan; jinak override zvítězí.

**Aktuální hodnoty:**
- `mazher.a@email.cz`, `a.mazher@email.cz`: **90** (paused)
- `b.maarek@email.cz`, `maarek.b@email.cz`: **120** (active)

**Kdy přepsat:** když warmup skončil a chceme pevný denní strop (typicky 120–150 pro Seznam). Nezvyšovat nad 150/den bez předchozí reputace.

```sql
UPDATE outreach_mailboxes SET daily_cap_override = 120 WHERE id = 631;
```

---

## 4. Český kalendář

**Kód:** `modules/outreach/internal/campaign/runner.go:99-105` + `modules/outreach/internal/calendar/cz.go`.

Skipuje se:
- **Víkendy** (sobota, neděle)
- **Fixní svátky:** 1.1., 1.5., 8.5., 5.7., 6.7., 28.9., 28.10., 17.11., 24.–26.12.
- **Pohyblivé svátky:** Velký pátek, Velikonoční pondělí (Meeus/Jones/Butcher algoritmus)

Dnes (`2026-04-22`, středa) = **sendable day**. Velikonoce 2026: Velikonoční pondělí 6.4. (už za námi).

**Bypass** (CI / testy): `SKIP_CALENDAR_CHECK=1`. V produkci **nenastavovat** — ESPs (Seznam, Gmail) throttlují spiky o svátcích.

---

## 5. Domain circuit breaker

**Kód:** `modules/outreach/internal/sender/engine.go:621-635`.

- **Trip:** po 10+ pokusech do domény, pokud `bounces/sent > MaxBounceRate` (default `0.05` = 5 %).
- **Per-mailbox cooldown:** 3 consecutive failures → 30 min park (`engine.go:158-159`).
- **Global circuit:** po 10+ odeslaných, pokud total `bounceRate > MaxBounceRate` → pauza celého sendera.

**Check state:** circuit breaker stav je in-memory (nepersistuje mezi restarty). Reset = restart workeru na Railway. Před restartem:

```bash
# Diagnostika přes metriky
railway logs --service machinery-outreach | grep -iE "circuit breaker|bounce_rate"
```

---

## 6. Troubleshooting: "emaily neodcházejí"

10-step diagnostic checklist:

1. **Send window?** `TZ=Europe/Prague date +%H` → je mezi 8–17?
2. **Sendable day?** Víkend nebo český svátek? (viz §4)
3. **Schránka aktivní?** `SELECT from_address, status, status_reason FROM outreach_mailboxes` — pokud `paused`, oprav AUTH ([`MAILBOX-PASSWORD-UPDATE.md`](./MAILBOX-PASSWORD-UPDATE.md)).
4. **Warmup paused?** `SELECT mailbox_address, is_paused, pause_reason FROM mailbox_warmup WHERE is_paused` — odblokuj po vyřešení příčiny.
5. **Daily cap vyčerpán?** Jednoduchý count dnešních `send_events` vs `daily_cap_override` / warmup limit.
6. **Circuit breaker?** `railway logs | grep "circuit breaker open"` → restart workeru po fix.
7. **Anti-trace-relay up?** `curl https://<relay>/healthz` + pool mailboxů není prázdný.
8. **Campaign status?** `SELECT name, status FROM campaigns WHERE status='running'` — pokud žádná není running, nic se nepošle.
9. **Kontakty ready?** `SELECT COUNT(*) FROM contacts WHERE status = 'valid' AND NOT exists(suppression)` — viz `runner.go` exclusion vocabulary.
10. **Worker běží?** `railway ps --service machinery-outreach-worker` (nebo ekvivalent).

Pokud všech 10 OK a stále nic → viz `docs/playbooks/runbook-async-job-pattern.md` pro hlubší pipeline debug.

---

**Související:**
- [`MAILBOX-PASSWORD-UPDATE.md`](./MAILBOX-PASSWORD-UPDATE.md) — AUTH/heslo rotace
- [`LOCAL-DEV-RELAY.md`](./LOCAL-DEV-RELAY.md) — relay pro dev testování
- [`../initiatives/2026-04-22-send-pipeline-unblock.md`](../initiatives/2026-04-22-send-pipeline-unblock.md) — SEND initiative (S4 provenance)
