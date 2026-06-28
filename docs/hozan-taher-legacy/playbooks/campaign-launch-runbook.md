# Runbook: Ruční spuštění kampane (verze 2 — po sprint Q1)

**Aktualizováno:** 2026-05-07  
**Předchozí verze:** 2026-05-06 (pokrývala pouze campaign-send-batch.mjs)  
**Reference:**
- [`send-paths.md`](../subsystem-maps/send-paths.md) — Go daemon vs Node script (čti před změnou send path)
- [`anti-trace.md`](../subsystem-maps/anti-trace.md) — 42-step email send pipeline
- [`bounce-handling.md`](../subsystem-maps/bounce-handling.md) — bounce klasifikace a flow

---

## Co tento dokument pokrývá

Tento runbook je single source of truth pro operátora při ručním spuštění kampaně. Verze 2 integruje všechny nástroje ze sprint Q1 (PR #996 – #1039): živý monitoring dashboard, BFF endpoint pro odeslání dávky, report na konci dne, SQL nástroje pro followup sekvenci, ramp utility pro warmup mailboxů a konsolidovaný launch-readiness check. Dokument popisuje celý postup od rána dne spuštění až po uzavření kampaně večer.

---

## Operátorská pravidla (MUST / MUST NOT)

**MUSÍ:**

- Kampaň musí zůstat ve stavu `draft` po celou dobu ručního rampování. Skript i BFF endpoint záměrně nevyžadují stav `running`, protože Go daemon by při `running` konkurenčně přiděloval kontakty ze stejné fronty.
- Odesílání smí běžet pouze v jedné instanci najednou. Paralelní volání způsobí race condition na `campaign_contacts.status` — oba procesy si přidělí stejné kontakty a odešlou duplicitní e-maily. (FOR UPDATE SKIP LOCKED chrání, ale paranoia OK.)
- Po dokončení celé rampy ručně povýšit status kampaně na `completed`.
- Hesla mailboxů se čtou výhradně z databáze. Nikdy se nezadávají inline do příkazové řádky ani se nezapisují do dokumentů.

**NESMÍ:**

- Klikat tlačítko „Aktivovat" v dashboardu. Go daemon by začal odesílat s obsahem `.tmpl` souboru z disku, který může být odlišný od DB verze šablony.
- Mixovat dashboard tlačítka s terminálovým skriptem nebo BFF endpointem — všechny cesty čtou ze stejné fronty `campaign_contacts` a způsobí duplicitní doručení.
- Měnit `sequence_config` kampaně během rampování. Skript čte konfiguraci mailbox poolu při startu; změna uprostřed rampování způsobí nekonzistentní distribuci mailboxů.

---

## Příprava prostředí (jednou za sezení)

```bash
cd /Users/messingtomas/Documents/Projekty/hozan-taher
set -a && source features/platform/outreach-dashboard/.env && set +a
```

---

## Sekce A — Pre-launch verifikace (7:30 – 8:00)

### A.0 — Rychlá verifikace (doporučeno: jeden příkaz, ~15 s)

Spusť jako první věc v 7:30. Výstup je ✅ READY TO LAUNCH nebo ❌ HALT s
actionable listem co fixnout. Pokud zelená → pokračuj přímo na Sekci B.

```bash
node features/platform/outreach-dashboard/scripts/pre-launch-check.mjs <CAMPAIGN_ID>
# Volitelně s JSON výstupem (pro scripting / CI):
node features/platform/outreach-dashboard/scripts/pre-launch-check.mjs <CAMPAIGN_ID> --json
```

Zkontroluje 10 podmínek najednou:

1. Kampaň ve stavu `draft`, pending kontakty > 0
2. ≥ 4 aktivní production mailboxy, all scores ≥ 80
3. Suppression UNION přístupná (obě tabulky)
4. Schema migrations head viditelný
5. Žádná aktivní SMOKE kampaň
6. Anti-trace relay bridge=ok, queue=0
7. BFF launch-readiness endpoint verdict=green (7 sanity gates) — skip pokud BFF offline
8. Požadované skripty přítomné na disku
9. Požadované env vars nastaveny
10. Nedávná aktivita v operator_audit_log (≤ 24h)

Pokud jakákoli podmínka selhá → ❌ HALT + seznam co opravit. Pokud BFF offline, check 7 dostane status `skip` (není failure — ověř launch-readiness ručně v dashboardu).

---

### A.1 — Detailní manuální verifikace (volitelně, pokud je třeba diagnostika)

Spusť při podezření na anomálii nebo po HALT z A.0. Všechny podmínky musí být zelené.

```bash
# 1. Finální stav kampaně — status=draft, mailbox pool nastaven
psql "$DATABASE_URL" -c "
  SELECT id, name, status,
         sending_config -> 'mailbox_pool'         AS pool,
         sending_config -> 'mailbox_pool_primary' AS primary_pool,
         sending_config -> 'mailbox_pool_backup'  AS backup_pool
  FROM campaigns
  WHERE id = <CAMPAIGN_ID>;
"

# 2. Počet pending kontaktů
psql "$DATABASE_URL" -c "
  SELECT status, COUNT(*) FROM campaign_contacts
  WHERE campaign_id = <CAMPAIGN_ID>
  GROUP BY status;
"

# 3. Relay zdraví — queue_depth by měl být nízký (0-5)
curl -sf \
  -H "Authorization: Bearer $ANTI_TRACE_RELAY_TOKEN" \
  -H "Accept: application/json" \
  "$ANTI_TRACE_RELAY_URL/v1/status"

# 4. Aktivní mailboxy — last_score ≥ 80 + environment check
psql "$DATABASE_URL" -c "
  SELECT id, from_address, status, last_score, last_score_at, environment
  FROM outreach_mailboxes
  WHERE id = ANY(ARRAY[1, 3, 631, 632])
  ORDER BY id;
"
# environment='test' = testovací mailbox (izolovaný od produkcních); environment='production' = ostrý

# 5. Žádná SMOKE kampaň ve stavu running (interference)
psql "$DATABASE_URL" -c "
  SELECT id, name, status FROM campaigns
  WHERE name LIKE 'SMOKE-%' AND status = 'running';
"
# Výsledek musí být prázdný

# 6. Launch-readiness consolidated check (4 sanity gates + CRM coverage + dedup guard)
curl -sf \
  -H "X-API-Key: $OUTREACH_API_KEY" \
  "http://localhost:18001/api/launch-readiness?campaign_id=<CAMPAIGN_ID>&segment_id=<SEGMENT_ID>" \
  | jq '{ verdict, action_items: .actionItems }'
# verdict='green' = pokračuj; verdict='amber' = zvaž; verdict='red' = halt
```

Pokud `verdict=red` nebo podmínka 3 ukáže `queue_depth > 10`, zastav a diagnostikuj před prvním odesláním.

---

## Sekce B — Spuštění a rampování (8:00 – 17:00)

Otevři dva terminály vedle sebe: jeden pro odesílání, druhý pro monitoring.

### Terminál 1 — odeslání dávky

Heslo mailboxu načti jednou na začátku sezení a ulož do proměnné:

```bash
SMTP_PASSWORD=$(psql "$DATABASE_URL" -At -c \
  "SELECT password FROM outreach_mailboxes WHERE id = 1")
```

**Varianta A — BFF endpoint** (doporučeno; jednodušší, audituje do operator_audit_log):

```bash
curl -sf -X POST \
  -H "X-API-Key: $OUTREACH_API_KEY" \
  -H "X-Confirm-Send: 1" \
  "http://localhost:18001/api/campaigns/<CAMPAIGN_ID>/send-batch?count=<COUNT>"
```

Hlavička `X-Confirm-Send: 1` je povinná — endpoint ji vyžaduje jako explicitní potvrzení operátora (viz paměť `feedback_campaign_send`). Bez ní vrátí HTTP 412.

> **Sprint T4 — rate limit:** Endpoint je chráněn in-process token bucketem — max 1 požadavek per kampaň per 30 s. Pokud operátor dostane HTTP 429, počkej počet sekund uvedený v poli `retry_after_seconds` odpovědi a zopakuj. Výchozí interval lze přepsat proměnnou `SEND_BATCH_RATE_LIMIT_MS` (v ms). Ochrana je per-campaign — paralelní odesílání pro různé kampaně se vzájemně neblokuje. Typické použití v rampovacím skriptu (`for`-loop) automaticky narazí na 429 při druhém volání do 30 s; to je očekávané chování, nikoli chyba.

**Varianta B — CLI skript** (fallback pokud BFF nedostupný):

```bash
RELAY_TOKEN="$ANTI_TRACE_RELAY_TOKEN" \
SMTP_PASSWORD="$SMTP_PASSWORD" \
DATABASE_URL="$DATABASE_URL" \
node features/platform/outreach-dashboard/campaign-send-batch.mjs <CAMPAIGN_ID> <COUNT>
```

Obě varianty přistupují ke stejné `campaign_contacts` frontě; nemixuj je v rámci jedné rampy.

### Harmonogram rampování

Rampování snižuje riziko bounce shluku a dává čas ISP filtrům naučit se positivní signál.

| Čas   | Dávka (COUNT) | Kumulativně | Poznámka                                   |
|-------|---------------|-------------|---------------------------------------------|
| 8:00  | 1             | 1           | Pilotní odeslání — ověř doručení ručně      |
| 9:00  | 3             | 4           | Zkontroluj bounce rate v live monitoru      |
| 10:00 | 6             | 10          |                                             |
| 11:00 | 15            | 25          | Zkontroluj logy relay — žádné CB tripy      |
| 13:00 | 25            | 50          |                                             |
| 15:00 | 50            | 100         | Finální dávka pro první den                 |

### Go/No-Go gate protokol (#1003 [S1.2])

Harmonogram výše je orientační podle hodin. **Řídí ho ale gate, ne hodiny** —
mezi dávkami se VŽDY čeká minimální dobu a teprve po splnění go-kritérií se
postupuje na další stupeň. Když gate selže, NEPOKRAČUJ — zastav (Sekce C).

| Stupeň | Dávka | Kumul. | Min. čekání PŘED dalším stupněm |
|--------|-------|--------|----------------------------------|
| 1      | 1     | 1      | 30 min                           |
| 2      | +5    | ~5–6   | 1 h                              |
| 3      | +15   | ~20    | 2 h                              |
| 4      | +30   | ~50    | 4 h                              |
| 5      | +50   | ~100   | konec dne 1                      |

**Na každém gate (před postupem na další stupeň) zkontroluj 3 signály:**

1. **Bounce rate — halt advisory.** V dashboardu na kartě kampaně (Kampaně →
   pill u kampaně) nebo přímo:
   ```bash
   curl -s -H "X-API-Key: $OUTREACH_API_KEY" \
     "http://localhost:18001/api/campaigns/<CAMPAIGN_ID>/halt-advisory" | jq '{status, bounce_rate_pct, thresholds}'
   ```
   - `status: "ok"` → **GO**
   - `status: "warn_pause"` (bounce ≥ `halt_bounce_pause_pct`, default 5 %) → **NO-GO**, pozastav a prošetři
   - `status: "hard_stop"` (bounce ≥ `halt_bounce_stop_pct`, default 10 %) → **NO-GO**, okamžitě zastav (Sekce C)
   - Prahy jsou v `operator_settings` (laditelné bez redeploye, viz migrace 148).

2. **Reply queue.** Záložka Odpovědi — projdi nové odpovědi od posledního
   gate. Žádný shluk „neznámý odesílatel / nedoručitelné / mimo provoz" mimo
   očekávání. Negative reply rate < 20 % (launch-monitor to hlídá).

3. **Launch-readiness.** Verdict musí zůstat zelený:
   ```bash
   curl -s -H "X-API-Key: $OUTREACH_API_KEY" \
     "http://localhost:18001/api/launch-readiness?campaign_id=<CAMPAIGN_ID>&segment_id=<SEGMENT_ID>" | jq '.verdict'
   ```

**Go/No-Go rozhodnutí:** postup na další stupeň jen když **všechny tři** jsou
zelené **a** uplynula minimální čekací doba. Jinak zůstaň na stupni nebo
zastav. Jeden drahý bounce shluk na stupni 1 (cena 1 mailu) je lepší než na
stupni 5 (cena reputace celého poolu).

### Terminál 2 — live monitoring dashboard

```bash
DATABASE_URL="$DATABASE_URL" \
node features/platform/outreach-dashboard/scripts/launch-monitor.mjs <CAMPAIGN_ID>
```

Volitelné parametry:
- `--interval=30` — interval pollingu v sekundách (výchozí 30)
- `--silent` — vypne terminálový zvon při halt advisory

Dashboard automaticky každých 30 s zobrazuje:
- Průběh kampaně (pending / in_sequence / sent)
- Bounce rate 24h (hard / soft)
- Reply rate 24h (positive / negative / auto_reply)
- Zdraví mailboxů (score / circuit breaker / bounce count per mailbox)
- Stav relay fronty (queue depth, stáří nejstaršího)
- Halt advisory s přesnými prahovými hodnotami (viz Sekce C)

---

## Sekce C — Kritéria pro zastavení a postup

### Halt kritéria (launch-monitor.mjs je hlídá automaticky)

| Podmínka                            | Práh          |
|-------------------------------------|---------------|
| Hard bounce rate                    | > 5 % odeslaných |
| Negative reply rate (při n ≥ 5)    | > 20 %        |
| Growth suppressionů                 | > 10 / minuta |
| Relay queue — stáří nejstaršího     | > 600 s       |
| Skóre mailboxu                      | < 60          |

Sentry upozorní automaticky při relay queue stuck (H4.2) a daemon dead (H4.3) — viz PR #1031.

### Postup při zastavení

```bash
# 1. Okamžitě pozastav kampaň
psql "$DATABASE_URL" -c "
  UPDATE campaigns SET status = 'paused', updated_at = NOW()
  WHERE id = <CAMPAIGN_ID>;
"

# 2. Pokud byly povoleny followupy, okamžitě je vypni
psql "$DATABASE_URL" \
  -v campaign_id=<CAMPAIGN_ID> \
  -f scripts/operations/disable-followups.sql

# 3. Diagnostika
# relay: GET /v1/status + /v1/envelopes?state=failed
# BFF systémový report: cd features/platform/outreach-dashboard && pnpm report
# Sentry: projekt machinery-outreach → alerts sekce
# Railway logy: railway logs --service machinery-outreach
```

Po odstranění příčiny: vrátit status na `draft` a restartovat skript nebo BFF volání.

---

## Sekce D — Uzavření kampaně (17:00+)

### End-of-day report

```bash
DATABASE_URL="$DATABASE_URL" \
node features/platform/outreach-dashboard/scripts/end-of-day-report.mjs <CAMPAIGN_ID>
```

Pro export do souboru:
```bash
DATABASE_URL="$DATABASE_URL" \
node features/platform/outreach-dashboard/scripts/end-of-day-report.mjs <CAMPAIGN_ID> --json \
  > report-$(date +%Y-%m-%d).json
```

Report zahrnuje: celkový počet odeslaných, bounce rate, reply rate, suppression count, zdraví mailboxů.

### Uzavření kampaně

```bash
psql "$DATABASE_URL" -c "
  UPDATE campaigns SET status = 'completed', updated_at = NOW()
  WHERE id = <CAMPAIGN_ID>;
"
# Ověř:
psql "$DATABASE_URL" -c "
  SELECT id, name, status, updated_at FROM campaigns WHERE id = <CAMPAIGN_ID>;
"
```

### Rozhodnutí o followup sekvenci

Povolení followupů je nevratný krok pro kontakty, kteří dosud neodpověděli. Před spuštěním ověř všechna kritéria z [`followup-enablement-decision.md`](followup-enablement-decision.md):

- Reply rate ≥ 5 % (orientačně 100+ intro odeslaných)
- Hard bounce rate < 5 %
- 0 stížností na ÚOOÚ
- Intro round běžel ≥ 7 dní

Pokud všechna kritéria platí:

```bash
psql "$DATABASE_URL" \
  -v campaign_id=<CAMPAIGN_ID> \
  -f scripts/operations/enable-followups.sql
```

Pokud ne, nebo se rozhodneš followupy nepovolit:

```bash
psql "$DATABASE_URL" \
  -v campaign_id=<CAMPAIGN_ID> \
  -f scripts/operations/disable-followups.sql
```

---

## Sekce E — Warmup nového mailboxu

Pokud byl do poolu přidán nový mailbox (environment='production'), musí projít warmupem před zařazením do produkční rampy. Viz [`dual-mailbox-pool-decision.md`](dual-mailbox-pool-decision.md) pro konfiguraci primary/backup poolu.

```bash
DATABASE_URL="$DATABASE_URL" \
RELAY_URL="$ANTI_TRACE_RELAY_URL" \
RELAY_TOKEN="$ANTI_TRACE_RELAY_TOKEN" \
SMTP_PASSWORD="$SMTP_PASSWORD" \
node features/platform/outreach-dashboard/scripts/mailbox-warmup-ramp.mjs \
  --mailbox-id=<MAILBOX_ID> \
  --day=<DEN_WARMUPU>
```

Výchozí denní ramp schedule: den 1 → 5, den 2 → 10, den 3 → 25, den 4 → 50, den 5+ → cíl (výchozí 100).

---

## Přehled nástrojů

| Nástroj | Cesta | Účel |
|---|---|---|
| Live monitor | `features/platform/outreach-dashboard/scripts/launch-monitor.mjs` | Real-time dashboard; halt advisory |
| Send batch (CLI) | `features/platform/outreach-dashboard/campaign-send-batch.mjs` | Ruční dávkové odeslání (fallback) |
| Send batch (BFF) | `POST /api/campaigns/:id/send-batch?count=N` | Doporučená cesta; audituje do operator_audit_log |
| Launch-readiness | `GET /api/launch-readiness?campaign_id=N&segment_id=M` | Consolidated pre-launch check (CRM + dedup + sanity gates) |
| End-of-day report | `features/platform/outreach-dashboard/scripts/end-of-day-report.mjs` | EOD souhrn; volitelně --json |
| Enable followups | `scripts/operations/enable-followups.sql` | Povolení 3-step sekvence |
| Disable followups | `scripts/operations/disable-followups.sql` | Vrácení na intro-only |
| Mailbox warmup | `features/platform/outreach-dashboard/scripts/mailbox-warmup-ramp.mjs` | Rampování nového mailboxu |

---

## Referenční dokumenty

| Dokument | Kdy číst |
|---|---|
| [`followup-enablement-decision.md`](followup-enablement-decision.md) | Před `enable-followups.sql` |
| [`dual-mailbox-pool-decision.md`](dual-mailbox-pool-decision.md) | Při konfiguraci primary/backup mailbox poolu |
| [`railway-services-triage.md`](railway-services-triage.md) | Při Railway service outage nebo FAILED stavu |
| [`docs/legal/privacy-notice.md`](../legal/privacy-notice.md) | Při dotazu na právní základ odesílání |
| [`docs/subsystem-maps/send-paths.md`](../subsystem-maps/send-paths.md) | Před jakoukoliv změnou send path |
| [`docs/subsystem-maps/anti-trace.md`](../subsystem-maps/anti-trace.md) | Při debugging relay nebo anonymity issues |

---

## Poznámky k bezpečnosti

- Hesla mailboxů se nikdy nezadávají inline do příkazové řádky ani se nezapisují do dokumentů. Vždy se čtou z databáze přes `$()` substituci nebo jsou nastavena přes UI.
- `ANTI_TRACE_RELAY_TOKEN` a `OUTREACH_API_KEY` se načítají výhradně z `.env` souboru, nikdy nejsou commit-ovány do repozitáře.
- Veškerá odesílání procházejí přes anti-trace-relay — přímé SMTP spojení je zakázáno (paměť `feedback_no_direct_smtp`).
- PII guard: BFF endpoint ani CLI skript nevrací surové e-mailové adresy v odpovědích ani na stdout. Výstup obsahuje pouze `contact_id` + `envelope_id`.
