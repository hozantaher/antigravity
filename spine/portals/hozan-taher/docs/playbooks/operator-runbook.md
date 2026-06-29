# Operator Runbook — Denní provoz outreach platformy

**Status:** Active
**Datum:** 2026-05-01
**Trigger:** OP5.2 — finální dokumentace po přistání OP1–OP4

---

## Povinná četba před prvním dnem

Než si otevřeš dashboard, přečti si tyhle čtyři věci. Jsou krátké a zabrání ti sáhnout na špatné tlačítko v nesprávný moment.

1. `feedback_campaign_send` — jedno tlačítko, žádné odvolání
2. `feedback_mailbox_passwords_via_db` — hesla nikdy do env vars
3. `feedback_operator_focus` — primární osa: reply triage, ne provider konfigurace
4. [ADR-005](../decisions/ADR-005-airtight-dev-env.md) — dev airtight gate (`LAB_ONLY=1`)

---

## Denní rutina

Operator přichází ráno a prochází tří kroky v pořadí. Pořadí je záměrné — každý krok odhalí blocker před tím, než udělá krok následující.

### Krok 1: Schránky

Otevři `/priprava` (klávesa `⌘0`). První karta „Schránky s heslem" musí být zelená. Zelená znamená, že všech 24 aktivních schránek má heslo delší než 8 znaků a žádné z nich není placeholder (`xxxx`, `password`, `change-me`).

Pokud je karta červená, expand ji a uvidíš seznam konkrétních schránek. Pro každou:

1. Jdi na `/mailboxes` → klikni řádek schránky → drawer „Upravit"
2. Vyplň heslo (16znakový Seznam app-specific password; generuj na email.seznam.cz → Developer Settings → App Passwords)
3. Uložit

Hesla smí žít pouze v databázi nebo v password manageru. Nikdy do `.env`, nikdy do Railu, nikdy do chatu.

### Krok 2: Šablona

Druhá karta musí mít aspoň jednu šablonu s neprázdným předmětem i tělem. Pokud ne, klikni na odkaz → `/templates?new=1` → vytvoř šablonu. GDPR patička (identita, IČO, zdroj dat, unsub link) se přidává automaticky v `runner.go` — do šablony ji nepsat ručně.

### Krok 3: Kontakty

Třetí karta ukáže počet odesilatelných kontaktů po aplikaci suppression UNION (`outreach_suppressions UNION suppression_list`). Pokud je 0, data nejsou nahrána nebo jsou všechny adresy suppressovány. Akce: `/companies` → zkontroluj import.

### Spuštění kampaně

Až všechny 3 karty jsou zelené, zobrazí se tlačítko „Pokračovat na Novou kampaň". Po vytvoření je kampaň v `paused`. Klikni Aktivovat → BFF spustí pre-flight (shodné podmínky jako Příprava) → první tick scheduleru (`features/outreach/campaigns/campaign/scheduler.go`) přijde do minuty.

---

## Reply triage

Toto je primární každodenní práce. Sekundární jsou konfigurace, monitoring, debugging.

Otevři `/replies` (klávesa `1`). Vlevo je seznam threadů. Kliknutím na thread se otevře ThreadDetail napravo: sanitizovaný HTML, přílohy, LLM klasifikační badge.

Klávesové zkratky pro override:

| Klávesa | Kategorie |
|---------|-----------|
| `i` | interested |
| `n` | not interested |
| `o` | out of office |
| `w` | wrong person |
| `s` | spam |

Pokud LLM badge říká „interested" a ty souhlasíš, žádná akce není nutná. Override proveď jen pokud klasifikátor zjevně chybuje. Každý override se zaznamenává do `operator_audit_log` — tyhle záznamy trénují iteraci modelu.

Po klasifikaci draftuješ reply. Použij tlačítko šablony nebo zapiš vlastní. Send routuje přes lab v dev módu; v produkci přes anti-trace-relay (nikdy přímý SMTP).

---

## Decision trees

Každá z níže uvedených situací je autonomně řešitelná. Eskaluj pouze tehdy, když krok „Akce" selže nebo ti chybí přístup.

### A. Kampaň mid-flight: mailbox přechází do bounce_hold

Watchdog (`/watchdog`) zobrazí upozornění s `event_type = 'bounce_hold'`. Orchestrátor automaticky zastaví odesílání z tohoto mailboxu a po 7 dnech jej zkusí automaticky uvolnit (`autoReleaseBounceHold`, `intelligence/loop.go:136`).

**Co dělat:**

1. Zkontroluj `/watchdog` → filtruj `bounce_hold` → najdi mailbox
2. Rozklikni záznam: vidíš `consecutive_bounces` a posledních 5 bounce events
3. Pokud je bounce rate < 5% (hard bounces / total sent) a jedná se o série soft bounces — mailbox se pravděpodobně sám uvolní za 7 dní, žádná akce
4. Pokud je bounce rate > 15% nebo vidíš hard bounces s `550 5.1.1` (adresa neexistuje) → mailbox je pravděpodobně kompromitován; proveď ruční unblock přes `/mailboxes` → Edit → status → active a okamžitě zkontroluj authenticity nastavení v Seznam
5. Pokud `consecutive_bounces ≥ 5` a bounce rate stoupá → zastav kampaň přes `/campaigns/:id` → Pause a reportuj koordinátorovi

**Nikdy** manuálně neresetuj `consecutive_bounces` v DB bez pochopení příčiny. Číslo je ochranna zábrana.

### B. Classifier vrací nízkou confidence

LLM badge zobrazuje `confidence < 0.6` nebo kategorii `unclear`. Toto je normální pro ambiguní odpovědi.

**Co dělat:**

1. Přečti reply celý — obvykle je kategorie jasná z kontextu (OOO podpis, explicitní odmítnutí, dotaz na cenu)
2. Override klávesou (viz tabulka výše)
3. Pokud si nejsi jistý ani ty, kategorizuj jako `not_interested` — safer default
4. Pokud vidíš > 30% override rate za den (`node scripts/operator-practice/session-stats.mjs --since 24h`), zapiš do GH issue — může indikovat prompt drift nebo nová kategorie dat

Nikdy nepřeklápeš kategorii zpátky na AI výsledek bez přesvědčení — override je finální.

### C. Bounce rate spikuje

Dashboard `/observability` nebo Sentry alert `BOUNCE_RATE_HIGH`. Prahová hodnota pro automatiku: `BounceRate > 0.08` → cap redukce; `BounceRate > 0.15` → doménová supprese (`intelligence/domain.go:70`).

**Co dělat:**

1. `pnpm report` z `features/platform/outreach-dashboard/` → sekce „Bounce" → ukáže per-domain breakdown
2. Pokud spike pochází z jedné domény (típ: `seznam.cz` target adresy mají vyšší bounce rate po pondělní rotaci) → pozastav kampaň na 2 hodiny, pak zkus znovu
3. Pokud spike pochází uniformně ze všech domén → zastav kampaň; problém je na straně odesílatele (IP reputace nebo mailbox kompromitován)
4. Přečti `docs/playbooks/sql/bounce-investigation.sql` — SQL dotaz ukáže cluster zdrojů bounce event za posledních 24h

**Pauza vs. vyšetřování:**

- Bounce rate 5–8%: vyšetřuj, nepauzu (sleduj 30 min)
- Bounce rate 8–15%: pauza do zjištění příčiny
- Bounce rate > 15%: zastav okamžitě, reportuj

### D. Egress drift detekován

`/api/health/drift` nebo `pnpm report` → sekce „Egress" vrátí `drift: true`. Typická příčina: wireproxy restart nebo změna Mullvad konfigurace.

**Co dělat:**

1. Přečti [launch-readiness.md](launch-readiness.md) → sekce „Egress airtight check"
2. Ověř wireproxy stav: `railway logs --service orchestrator | grep wireproxy`
3. Pokud wireproxy nereaguje: restart service přes Railway dashboard → Variables → uložit → Deploy
4. Po restartu znovu zkontroluj `/api/health/drift` — musí vrátit `drift: false` před pokračováním v odesílání
5. Pokud drift přetrvává: spusť `/diagnostika/anonymita` v dashboardu — ukáže konkrétní L1/L2/L3/L4 skóre a identifikuje, kde dochází k úniku

---

## Nástroje

### `pnpm report`

Spouštěj z `features/platform/outreach-dashboard/`:

```bash
cd features/platform/outreach-dashboard && pnpm report
```

Unified diagnostic v terminálu: mailbox stav, send pipeline, bounce rate, proxy pool, cron heartbeaty, schéma drift. Výstup je text; barvení indikuje OK/WARNING/ERROR. Je to nejrychlejší způsob, jak zjistit, co je rozbité, aniž bys otvíral 5 záložek.

### `/priprava`

Dashboard URL: `/priprava` (klávesa `⌘0`). Vizuální agregát tří readiness stavů. Refresh každých 60 s nebo klik na tlačítko refresh vpravo nahoře.

API endpoint: `GET /api/morning-readiness` — vrací JSON se `steps[]` a `blockers[]`.

### `/diagnostika/anonymita`

Dashboard URL: `/diagnostika/anonymita`. Spouští anonymity test po řídkém použití (netriviální výpočet). Vrací 4vrstvé skóre: L1 IP leakage, L2 header fingerprint, L3 envelope match, L4 DKIM/SPF/DMARC. Hraniční hodnoty viz `cmd/anonymity-score/`.

### `GET /api/operator/metrics`

BFF endpoint dostupný na lokálním serveru i v produkci. Vrací JSON snapshot operátorsky relevantních metrik (viz OP5.3). Formát:

```json
{
  "generated_at": "2026-05-01T08:00:00Z",
  "campaigns": [...],
  "mailboxes": [...],
  "operator": {...}
}
```

Shodný datový zdroj jako Prometheus `/metrics` (Go orchestrátor), jen přebalený pro dashboard.

---

## SQL pro read-only diagnostiku

Následující dotazy jsou uloženy v `docs/playbooks/sql/`. Žádný z nich nemodifikuje data. Kopíruj a spouštěj přes Railway psql shell nebo Postico.

### Aktuální stav odesílání

```sql
-- viz docs/playbooks/sql/send-status.sql
SELECT c.id, c.name, c.status,
       COUNT(se.id) FILTER (WHERE se.sent_at > now() - interval '24h') AS sent_24h,
       COUNT(be.id) FILTER (WHERE be.created_at > now() - interval '24h') AS bounced_24h
FROM outreach_campaigns c
LEFT JOIN send_events se ON se.campaign_id = c.id
LEFT JOIN bounce_events be ON be.send_event_id = se.id
WHERE c.status = 'running'
GROUP BY c.id, c.name, c.status
ORDER BY sent_24h DESC;
```

### Bounce rate per mailbox (posledních 24h)

```sql
-- viz docs/playbooks/sql/bounce-investigation.sql
SELECT m.from_address,
       COUNT(se.id) AS sent,
       COUNT(be.id) AS bounced,
       ROUND(COUNT(be.id)::numeric / NULLIF(COUNT(se.id), 0) * 100, 1) AS bounce_pct
FROM outreach_mailboxes m
LEFT JOIN send_events se ON se.mailbox_address = m.from_address
     AND se.sent_at > now() - interval '24h'
LEFT JOIN bounce_events be ON be.send_event_id = se.id
GROUP BY m.from_address
ORDER BY bounce_pct DESC NULLS LAST;
```

### Reply classifier overrides dnes

```sql
-- viz docs/playbooks/sql/classifier-overrides.sql
SELECT al.action, al.entity_type, al.details->>'from_category' AS from_cat,
       al.details->>'to_category' AS to_cat, COUNT(*) AS n
FROM operator_audit_log al
WHERE al.created_at > now() - interval '24h'
  AND al.action = 'reply_classify_override'
GROUP BY al.action, al.entity_type, al.details->>'from_category', al.details->>'to_category'
ORDER BY n DESC;
```

### Mailbox circuit stav

```sql
-- viz docs/playbooks/sql/mailbox-circuit.sql
SELECT from_address, status, consecutive_bounces, last_score, last_score_at,
       total_sent, total_bounced,
       ROUND(total_bounced::numeric / NULLIF(total_sent, 0) * 100, 1) AS lifetime_bounce_pct
FROM outreach_mailboxes
ORDER BY consecutive_bounces DESC, total_sent DESC;
```

### Suppression UNION check

```sql
-- viz docs/playbooks/sql/suppression-check.sql
-- Kolik unikátních adres je v obou suppression tabulkách (per memory two_suppression_tables)
SELECT 'outreach_suppressions' AS src, COUNT(*) FROM outreach_suppressions
UNION ALL
SELECT 'suppression_list', COUNT(*) FROM suppression_list
UNION ALL
SELECT 'union_total',
       COUNT(*) FROM (
         SELECT lower(trim(email)) FROM outreach_suppressions
         UNION
         SELECT lower(trim(email)) FROM suppression_list
       ) u;
```

---

## Eskalace

Pro každý problém existuje „kdo to ví" kontext:

| Problém | Kde hledat | Eskalace |
|---------|-----------|----------|
| Mailbox bounce spike | `/watchdog`, `pnpm report` | Koordinátor (posoudit IP reputaci) |
| Wireproxy nefunguje | Railway logs, `/api/health/drift` | Koordinátor (rotace Mullvad serveru) |
| DB migration pending | `scripts/deploy/preflight.sh` výstup | Koordinátor (migration runner) |
| SMTP AUTH failure ≥ 3× za 15 min | `/api/health/auth-fail-alerts` banner | Koordinátor (rotace app password) |
| Sentry CRITICAL alert | Sentry dashboard → issue detail | Koordinátor okamžitě |
| Classifier accuracy < 70% za týden | `session-stats.mjs --since 7d` | Koordinátor (prompt review) |
| Proxy pool prázdný | `pnpm report` → sekce Proxy | Koordinátor (Mullvad token) |

Koordinátor je Tomáš. V budoucnosti se doplní kontakty nových operátorů.

---

## Paměťové tagy pro nové operátory

Kontext je uložen ve struktuře memory tagů v `~/.claude/projects/*/memory/`. Nový operátor (lidský nebo AI) by měl přečíst v tomto pořadí:

1. `project_layout.md` — struktura monorepa
2. `feedback_operator_focus.md` — co je primární práce
3. `feedback_campaign_send.md` — co nikdy nedělat bez souhlasu
4. `feedback_mailbox_passwords_via_db.md` — hard rule hesla
5. `project_egress_canonical.md` — jak funguje egress a wireproxy
6. `project_two_suppression_tables.md` — proč jsou dvě suppression tabulky
7. `feedback_no_speculation.md` — jen fakta, ne domněnky

---

## Subsystem map

Rychlá orientace: kde co žije, pokud potřebuješ kopat hlouběji.

| Subsystém | Kód | Odpovědnost |
|-----------|-----|-------------|
| Scheduler | `features/outreach/campaigns/campaign/scheduler.go` | Tick → send per campaign |
| Send engine | `features/outreach/campaigns/sender/engine.go` | Anti-trace-relay dispatch |
| Intelligence loop | `features/inbound/orchestrator/intelligence/loop.go` | 6h analytics: scores, domains, watchdog |
| Mailbox scoring | `features/inbound/orchestrator/intelligence/mailbox_score_loop.go` | 4h SMTP probe per mailbox |
| Reply classifier | `features/inbound/orchestrator/llm/classify.go` | LLM reply classification |
| Operator practice | `features/platform/operator-practice/` | Lab seeding, anonymizer, IMAP inject |
| BFF server | `features/platform/outreach-dashboard/server.js` | Express proxy + direct-DB endpoints |
| Morning readiness | `features/platform/outreach-dashboard/src/server-routes/morningReadiness.js` | `/api/morning-readiness` |
| Operator metrics | `features/inbound/orchestrator/intelligence/operator_metrics.go` | `/api/operator/metrics` export |
| Domain health | `features/inbound/orchestrator/intelligence/domain.go` | Bounce cap, suppression |
| Metrics (Prometheus) | `features/platform/common/metrics/` | Counters, gauges, `/metrics` handler |
| Telemetry | `features/platform/common/telemetry/` | Sentry init, breadcrumbs, release tag |

---

## Related docs

- [morning-routine.md](morning-routine.md) — stručný 3-krok denní start
- [operator-launch-checklist.md](operator-launch-checklist.md) — 90min Phase 0 launch session
- [first-campaign-launch.md](first-campaign-launch.md) — 0→1→5→20 staircase s rollback triggery
- [operator-practice.md](operator-practice.md) — lab practice mode
- [launch-readiness.md](launch-readiness.md) — egress airtight check
- [AUTH-FAIL-ALERT-RESPONSE.md](AUTH-FAIL-ALERT-RESPONSE.md) — SMTP AUTH failure response
- [slog-conventions.md](slog-conventions.md) — op field konvence pro Sentry grouping
- Initiative: `docs/initiatives/2026-04-30-operator-practice.md`
