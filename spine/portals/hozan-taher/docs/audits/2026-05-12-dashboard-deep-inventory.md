# Dashboard Deep Inventory — Post-Recovery Audit
**Datum:** 2026-05-12  
**Trigger:** Outreach-DB wipe 23:07 UTC 2026-05-11, recovery dokončena  
**Scope:** 18 dashboard oblastí, lokální BFF :18001 + Vite :18175

## Stav po recovery (rychlý přehled)

| Oblast | Stav | Kritická data |
|--------|------|---------------|
| 1. Příprava rána | ⚠️ | 2 blokery (templates + segments) |
| 2. Odpovědi | ✅ | prázdné (normální po wipe) |
| 3. Kampaně | ⚠️ | 1 produkční kampaň, 12 test-artefaktů bez status |
| 4. Schránky | ✅ | 2 aktivní mailboxy, score 100 |
| 5. Firmy | ❌ | 426k rows, API vrací 0 — NULL bool bug |
| 6. Uložené filtry | ❌ | endpoint neexistuje (404) |
| 7. Kontakty | ✅ | 426k rows, API funkční |
| 8. Leady | ✅ | prázdné (normální po wipe) |
| 9. Šablony | ⚠️ | 1 template v DB, ale `/priprava-rana` vidí 0 |
| 10. Skórování | ⚠️ | config prázdný (weights={}), scoring degraded mode |
| 11. CRM klienti | ✅ | 2271 klientů, API 200 |
| 12. Entita + brand | ✅ | 6 settings seednutých |
| 13. ICP sektory | ✅ | 9 sektorů, nace_prefixes NULL |
| 14. Analytika | ⚠️ | overview 200, 2 sub-endpoints 404 |
| 15. Upozornění | ✅ | žádné aktivní alerty (normální) |
| 16. Pozorovatelnost | ⚠️ | cron error: runMullvadEndpointReputationCron |
| 17. Diagnostika anonymity | ⚠️ | 0 testů, žádná historická data |
| 18. Dedup Guard | ⚠️ | stats 200, segment-funnel 500 (schema bug) |

---

## 1. Příprava rána

- **Route:** `/priprava-rana` → `src/pages/PripravaRana.jsx`
- **API endpoints:** `GET /api/morning-readiness` → 200
- **DB tabulky:** `outreach_mailboxes` (2 rows), `templates` (0 rows!), `outreach_contacts` (0 rows)
- **Stav po recovery:** ⚠️ částečně — `ok: false`
- **Naplnění správnými daty:** ne — 2 blokery
- **Identifikované bugy:**
  1. `src/server-routes/morningReadiness.js:121` — krok "šablony" dotazuje tabulku `templates` (legacy, prázdná), nikoli `email_templates` (kde je `intro_machinery`). Výsledek: reportuje 0 šablon i když 1 existuje.
  2. `src/server-routes/morningReadiness.js:183` — krok "segmenty" dotazuje `outreach_contacts` JOIN `outreach_companies` (oboje 0 rows po wipe). Tabulka `contacts` má 426k rows, ale tento krok čte jinou tabulku.
- **Doporučená akce:** Opravit dotaz na `email_templates`; pro segmenty zvážit fallback na `contacts` pokud `outreach_contacts` prázdné.

**curl:**
```bash
API_KEY=$(grep '^OUTREACH_API_KEY=' features/platform/outreach-dashboard/.env | cut -d= -f2-)
curl -s -H "x-api-key: $API_KEY" http://localhost:18001/api/morning-readiness | python3 -m json.tool
```

---

## 2. Odpovědi

- **Route:** `/replies` → `src/pages/Replies.jsx`
- **API endpoints:**
  - `GET /api/replies` → 200 `{"rows":[],"total":0}`
  - `GET /api/replies/stats` → 200 `{"total":0,"unhandled":0,"positive":0,"negative":0,...}`
- **DB tabulky:** `outreach_threads` (0 rows), `reply_inbox` (0 rows)
- **Stav po recovery:** ✅ funguje — prázdné protože wipe
- **Naplnění správnými daty:** ne (normální — odpovědi přijdou až po poslaných e-mailech)
- **Identifikované bugy:** žádné
- **Doporučená akce:** žádná — stav je správný

---

## 3. Kampaně

- **Route:** `/campaigns`, `/campaigns/:id` → `src/pages/Campaigns.jsx`, `CampaignDetail.jsx`
- **API endpoints:**
  - `GET /api/campaigns` → 200 (13 kampaní)
  - `GET /api/campaigns/457` → 200
  - `GET /api/campaigns/457/launch-stats` → 200
  - `GET /api/campaigns/457/preflight` → 200 (ok=false: full-check stale)
  - `GET /api/campaigns/457/estimate` → 200 `{"count":0}` — 0 protože `/api/companies` vrací 0 (viz bug #5)
- **DB tabulky:** `campaigns` (13 rows), `campaign_contacts` (45906 rows — kampaň 457 enrolled)
- **Stav po recovery:** ⚠️ částečně
- **Naplnění správnými daty:** kampaň 457 OK; 12 testovacích kampaní (id 1–12) nemají `status` (NULL) — zobrazí se v UI jako "neznámý stav"
- **Identifikované bugy:**
  1. Kampaně id 1–12: `status = NULL`, `name` je test/xxxxxxx — UI chip-filter nepočítá je správně (0 active, 0 paused, 0 draft)
  2. `GET /api/campaigns/457/estimate` vrací `{"count":0}` kvůli bug v companies API (bod 5)
  3. `GET /api/campaigns/457/preflight` → `full_check_fresh: false` — mailboxy nemají fresh full-check ≤6h
- **Doporučená akce:** Smazat testovací kampaně 1–12 (nebo nastavit status); spustit full-check na mailboxech.

---

## 4. Schránky

- **Route:** `/mailboxes` → `src/pages/Mailboxes.jsx`
- **API endpoints:** `GET /api/mailboxes` → 200 (2 mailboxy)
- **DB tabulky:** `outreach_mailboxes` (2 rows)
- **Stav po recovery:** ✅ funguje
- **Naplnění správnými daty:** ano — oba mailboxy `status=active`, `lifecycle_phase=warmup_d0`, `last_score=100`, `daily_cap_override=100`
- **Identifikované bugy:**
  1. `cron_heartbeats`: `runMullvadEndpointReputationCron` hlásí error "is not defined" (viz bod 16)
  2. `health/system` → `watchdog_stale: true` — Go watchdog daemon neaktivní
- **Doporučená akce:** Spustit full-check pro oba mailboxy; prověřit Go daemon.

---

## 5. Firmy

- **Route:** `/companies` → `src/pages/Companies.jsx`
- **API endpoints:**
  - `GET /api/companies` → 200 `{"rows":[],"total":0}` — **KRITICKÝ BUG**
  - `GET /api/companies/facets` → 200 (prázdné facets)
- **DB tabulky:** `companies` (426296 rows — data jsou v pořádku)
- **Stav po recovery:** ❌ broken
- **Naplnění správnými daty:** data jsou v DB ale API nic nevrací
- **Identifikované bugy:**
  1. **KRITICKÝ** — `src/server-routes/companies.js:75` — WHERE klauzule obsahuje `v_likvidaci=false AND v_insolvenci=false`. Oba sloupce jsou `boolean NOT NULL DEFAULT NULL` — po recovery jsou NULL. `NULL=false` je v PostgreSQL NULL (ne true), tedy 0 rows. Správně: `(v_likvidaci IS NULL OR v_likvidaci=false)`.
  2. Companies facets cache `cachedAt` existuje, ale všechny hodnoty prázdné (ICP/size/email/engagement = `{}`).
- **Doporučená akce:**
  ```sql
  -- Okamžitý fix: nastavit NULL → false
  UPDATE companies SET v_likvidaci=false WHERE v_likvidaci IS NULL;
  UPDATE companies SET v_insolvenci=false WHERE v_insolvenci IS NULL;
  -- Nebo opravit server-routes/companies.js:75 (bezpečnější)
  ```

---

## 6. Uložené filtry

- **Route:** pravděpodobně `/saved-filters` nebo součást `/companies`
- **API endpoints:** `GET /api/saved-filters` → **404 Not Found**
- **DB tabulky:** žádná `saved_filters` tabulka v DB
- **Stav po recovery:** ❌ broken — endpoint neexistuje v BFF
- **Naplnění správnými daty:** ne
- **Identifikované bugy:**
  1. `GET /api/saved-filters` vrací 404 — endpoint není zaregistrován v server-routes
  2. Tabulka `saved_filters` neexistuje v DB schema
- **Doporučená akce:** Ověřit zda je tato oblast plánovaná nebo deprecated. Endpoint ani tabulka neexistují — pokud je UI route aktivní, zobrazí chybu.

---

## 7. Kontakty

- **Route:** `/contacts` → `src/pages/Contacts.jsx`
- **API endpoints:** `GET /api/contacts?limit=N` → 200 `{"rows":[...],"total":426296}`
- **DB tabulky:** `contacts` (426296 rows)
- **Stav po recovery:** ✅ funguje
- **Naplnění správnými daty:** ano — 426k kontaktů dostupných
- **Identifikované bugy:** žádné kritické
- **Sample fields:** `id, email, first_name, last_name, company_name, status, email_status, email_verified_at, email_confidence, last_contact_at, total_sent, suppressed, crm_client_id`
- **Doporučená akce:** žádná urgentní

---

## 8. Leady

- **Route:** `/leads` → `src/pages/Leads.jsx`
- **API endpoints:** `GET /api/leads` → 200 `{"leads":[],"total":0}`
- **DB tabulky:** `leads` (0 rows)
- **Stav po recovery:** ✅ funguje — prázdné je správně
- **Naplnění správnými daty:** ne (normální — leady vznikají z odpovědí)
- **Identifikované bugy:** žádné
- **Doporučená akce:** žádná

---

## 9. Šablony

- **Route:** `/templates` → `src/pages/Templates.jsx`
- **API endpoints:** `GET /api/templates` → 200 (1 šablona `intro_machinery`)
- **DB tabulky:** `email_templates` (1 row: `intro_machinery`), `templates` (0 rows — legacy)
- **Stav po recovery:** ⚠️ částečně
- **Naplnění správnými daty:** ano — `intro_machinery` je seed template, správně zachovaný
- **Identifikované bugy:**
  1. `/api/morning-readiness` dotazuje tabulku `templates` (0 rows) místo `email_templates` (1 row) → hlásí "Žádné šablony" — viz bod 1
  2. `body_html`, `subject_variants`, `body_variants` jsou NULL — funkčně OK (plain-text only)
- **Doporučená akce:** Opravit `morningReadiness.js:121` dotaz.

---

## 10. Skórování

- **Route:** `/scoring` → `src/pages/Scoring.jsx`
- **API endpoints:**
  - `GET /api/scoring/config` → 200 `{"weights":{},"version":"1",...}`
  - `GET /api/scoring/stats` → 200 (575 C-tier, 2935 D-tier, 422786 stale)
  - `POST /api/scoring/preview` → 200 `{"degraded":true,...}` — fallback mode
  - `POST /api/scoring/learn` → funkční
  - `POST /api/scoring/recompute-all` → funkční
- **DB tabulky:** `scoring_config` (1 row: `weights={}`)
- **Stav po recovery:** ⚠️ částečně
- **Naplnění správnými daty:** config je prázdný (`weights={}`), scoring degraded
- **Identifikované bugy:**
  1. `scoring_config.weights = {}` — bez vah scoring používá DEFAULT_WEIGHTS z kódu (funkční ale suboptimální)
  2. `POST /api/scoring/preview` vrací `degraded: true` — důvod: `send_events` nemá `company_id` sloupec, takže subquery `(SELECT COUNT(*) FROM send_events se WHERE se.company_id = c.id ...)` failuje a scoring padá do fallback query
  3. 422786 kontaktů má stale score (>7 dní) — scoring recompute je nutný
- **Doporučená akce:** Spustit `POST /api/scoring/recompute-all`; naplnit scoring_config smysluplnými váhami.

---

## 11. CRM klienti

- **Route:** `/crm` → `src/pages/CrmClients.jsx`
- **API endpoints:** `GET /api/crm/clients` → 200 `{"rows":[...],"total":2271}`
- **DB tabulky:** `crm_clients` (2271 rows, import `eway_xlsx_2026-05-12`)
- **Stav po recovery:** ✅ funguje
- **Naplnění správnými daty:** ano — 2271 CRM klientů dostupných
- **Pozorování:** `linked_companies` a `linked_contacts` jsou u většiny 0 — CRM backfill přes ICO match pravděpodobně nespuštěný po importu
- **Identifikované bugy:** žádné kritické
- **Doporučená akce:** Spustit CRM backfill ICO→contacts (viz CLAUDE.md CRM integration note).

---

## 12. Entita + brand

- **Route:** `/settings/branding` → `src/pages/SettingsBranding.jsx`
- **API endpoints:** `GET /api/operator-settings` → 200 (6 klíčů)
- **DB tabulky:** `operator_settings` (6 rows)
- **Stav po recovery:** ✅ funguje
- **Naplnění správnými daty:** ano
- **Seednuté hodnoty:**
  - `brand_label: "Garaaage"`
  - `controller_name: "Garaaage s.r.o."`
  - `controller_ico: "23219700"`
  - `controller_address: "Praha"`
  - `legal_basis: "Oprávněný zájem (Art. 6/1/f)"`
  - `privacy_url: "https://garaaage.cz/privacy"`
- **Identifikované bugy:** žádné
- **Doporučená akce:** žádná

---

## 13. ICP sektory

- **Route:** `/settings/icp` → `src/pages/SettingsICP.jsx`
- **API endpoints:** `GET /api/icp-sectors` → 200 (9 sektorů)
- **DB tabulky:** `icp_sectors` (9 rows)
- **Stav po recovery:** ✅ funguje
- **Naplnění správnými daty:** ano — 9 sektorů aktivních
- **Identifikované bugy:**
  1. `nace_prefixes = NULL` pro všechny sektory — AI NACE klasifikace (`getLIAScopeNACE`) bude pracovat bez prefixů, může degradovat přesnost
- **Seednuté sektory:** construction, machinery, agriculture, transport_logistics, forestry_wood, auto_service, mining_quarry, waste_recycling, landscaping
- **Doporučená akce:** Naplnit `nace_prefixes` přes `/settings/icp` UI nebo SQL pro lepší targeting přesnost.

---

## 14. Analytika

- **Route:** `/analytics` → `src/pages/Analytics.jsx`
- **API endpoints:**
  - `GET /api/analytics/overview` → 200 `{"total_sent":1,"total_replied":0,"total_opened":0,...}`
  - `GET /api/analytics/campaigns` → 200 (13 kampaní s stats)
  - `GET /api/analytics/timeline?days=7` → 200 (timeline data)
  - `GET /api/analytics/campaign-summary` → **404**
  - `GET /api/analytics/sends-by-day` → **404**
- **DB tabulky:** `send_events` (1 row), `tracking_events` (0 rows), `outreach_events` (check needed)
- **Stav po recovery:** ⚠️ částečně
- **Naplnění správnými daty:** minimální (1 send event)
- **Identifikované bugy:**
  1. `GET /api/analytics/campaign-summary` → 404 — endpoint neregistrovaný
  2. `GET /api/analytics/sends-by-day` → 404 — endpoint neregistrovaný
- **Doporučená akce:** Ověřit zda UI tyto endpointy volá a zda je potřeba je doplnit.

---

## 15. Upozornění

- **Route:** `/watchdog` → `src/pages/Watchdog.jsx`
- **API endpoints:**
  - `GET /api/health/auth-fail-alerts` → 200 `{"alerts":[],"count":0}`
  - `GET /api/protections/alerts` → 200 `{"alerts":[],...}`
  - `GET /api/health/alerts` → **404**
  - `GET /api/protections/status` → **404**
- **DB tabulky:** `protection_alerts` (0 rows), `mailbox_alerts` (2 rows — resolved)
- **Stav po recovery:** ✅ funguje (žádné aktivní alerty je správný stav)
- **Naplnění správnými daty:** ano — normální prázdný stav
- **Identifikované bugy:**
  1. `GET /api/health/alerts` → 404 (Watchdog.jsx volá `/api/health/watchdog`, ne `/api/health/alerts` — 404 se nevyskytuje v UI flow)
  2. `GET /api/health/system` → `watchdog_stale: true` — Go orchestrator/watchdog daemon neaktivní
- **Doporučená akce:** Ověřit zda Go daemon běží na Railway.

---

## 16. Pozorovatelnost

- **Route:** `/observability` → `src/pages/Observability.jsx`
- **API endpoints:**
  - `GET /api/health/invariants` → 200 `{"ok":null,...}` — `ok=null` (žádné synthetic runs)
  - `GET /api/health/cron-heartbeats` → 200 (24 cronů, 0 stale)
  - `GET /api/synthetic-runs` → 200 `{"runs":[]}`
- **DB tabulky:** `cron_heartbeats` (24 rows), `synthetic_runs` (0 rows)
- **Stav po recovery:** ⚠️ částečně
- **Naplnění správnými daty:** cron heartbeats OK; synthetic runs prázdné
- **Identifikované bugy:**
  1. `runMullvadEndpointReputationCron` — cron heartbeat hlásí `last_status: "error"`, `last_error: "runMullvadEndpointReputationCron is not defined"`. Cron je registrován v `server.js:6127` via `scheduleCron`, ale funkce není importována. Bug existující před wipe.
  2. `health/invariants.ok = null` — normální stav (žádné synthetic probe runs)
- **Doporučená akce:** Opravit import `runMullvadEndpointReputationCron` v server.js nebo odstranit ze scheduleCron.

---

## 17. Diagnostika anonymity

- **Route:** `/diagnostika-anonymita` → `src/pages/DiagnostikaAnonymita.jsx`
- **API endpoints:**
  - `GET /api/anonymity/all` → 200 (2 mailboxy, oba `last_run_id: null`)
  - `GET /api/anonymity/latest?mailbox_id=14228` → 200 `{"anonymity":null,"humanlike":null}`
  - `POST /api/anonymity/run` → funkční (spouští testy)
- **DB tabulky:** `anonymity_test_messages` (0 rows), `anti_trace_pings` (0 rows)
- **Stav po recovery:** ⚠️ částečně
- **Naplnění správnými daty:** ne — žádná historická data po wipe
- **Identifikované bugy:** žádné funkční
- **Doporučená akce:** Spustit `POST /api/anonymity/run` pro oba mailboxy pro baseline.

---

## 18. Dedup Guard

- **Route:** `/dedup-guard` → `src/pages/DedupGuard.jsx`
- **API endpoints:**
  - `GET /api/dedup-guard/stats?window=all` → 200 `{"axes":{...},"total_skipped":0}`
  - `GET /api/dedup-guard/recent-skips?limit=100` → 200 `{"count":0,"skips":[]}`
  - `GET /api/dedup-guard/segment-funnel?id=1` → **500** `{"error":"column c.segment_id does not exist"}`
  - `GET /api/dedup-guard/contact-block-reason?id=N` → funkční
- **DB tabulky:** `dedup_guard_log` tabulka **neexistuje** (data pravděpodobně v `suppression_list`)
- **Stav po recovery:** ⚠️ částečně
- **Naplnění správnými daty:** stats 0 (normální); segment funnel broken
- **Identifikované bugy:**
  1. **KRITICKÝ** — `src/server-routes/dedupGuard.js:149` — dotaz `WHERE c.segment_id = $1 AND c.is_deleted = FALSE` na tabulce `contacts`. Tabulka `contacts` nemá sloupce `segment_id` ani `is_deleted`. Výsledek: 500 error při kliknutí na "Segment Funnel" v UI.
  2. `dedup_guard_log` tabulka neexistuje v DB (možný schema drift po wipe)
- **Doporučená akce:** Opravit dotaz v `dedupGuard.js:149` — použít `segment_memberships` JOIN místo `contacts.segment_id`.

---

## Summary tabulka

| # | Oblast | HTTP | UI | Data | Stav |
|---|--------|------|----|----- |------|
| 1 | Příprava rána | 200 | 200 | bug | ⚠️ |
| 2 | Odpovědi | 200 | 200 | prázdné | ✅ |
| 3 | Kampaně | 200 | 200 | 1 prod + 12 ghost | ⚠️ |
| 4 | Schránky | 200 | 200 | 2 aktivní | ✅ |
| 5 | Firmy | 200 (total=0) | 200 | NULL bool bug | ❌ |
| 6 | Uložené filtry | 404 | N/A | chybí | ❌ |
| 7 | Kontakty | 200 | 200 | 426k rows | ✅ |
| 8 | Leady | 200 | 200 | prázdné | ✅ |
| 9 | Šablony | 200 | 200 | 1 template | ⚠️ |
| 10 | Skórování | 200 | 200 | weights={} | ⚠️ |
| 11 | CRM klienti | 200 | 200 | 2271 rows | ✅ |
| 12 | Entita + brand | 200 | 200 | 6 keys | ✅ |
| 13 | ICP sektory | 200 | 200 | 9 sektorů | ✅ |
| 14 | Analytika | 200/404 | 200 | 1 send | ⚠️ |
| 15 | Upozornění | 200 | 200 | čisté | ✅ |
| 16 | Pozorovatelnost | 200 | 200 | 1 cron error | ⚠️ |
| 17 | Diagnostika anonymity | 200 | 200 | prázdné | ⚠️ |
| 18 | Dedup Guard | 200/500 | 200 | segment-funnel 500 | ⚠️ |

---

## Top 5 blockerů pro production-ready

### BLOCKER 1 — Firmy API vrací 0 rows (❌ oblast 5)
**Soubor:** `features/platform/outreach-dashboard/src/server-routes/companies.js:75`  
**Příčina:** `WHERE ... AND v_likvidaci=false AND v_insolvenci=false` — sloupce jsou NULL po recovery, `NULL=false` → 0 rows.  
**Fix (SQL rychlý):**
```sql
UPDATE companies SET v_likvidaci = false WHERE v_likvidaci IS NULL;
UPDATE companies SET v_insolvenci = false WHERE v_insolvenci IS NULL;
```
**Fix (kód trvalý):**
```js
// companies.js:75
const conds = ['datum_zaniku IS NULL', '(v_likvidaci IS NULL OR v_likvidaci=false)', '(v_insolvenci IS NULL OR v_insolvenci=false)']
```
**Dopad:** Blokuje celou oblast Firem, campaign estimate vrací 0, scoring preview nemá data.

### BLOCKER 2 — Morning readiness hlásí 0 šablon (⚠️ oblast 1)
**Soubor:** `features/platform/outreach-dashboard/src/server-routes/morningReadiness.js:121`  
**Příčina:** dotaz `FROM templates` místo `FROM email_templates`. Operátor vidí blokér "Žádné šablony" i když `intro_machinery` existuje.  
**Fix:**
```js
// morningReadiness.js:121
FROM email_templates
```

### BLOCKER 3 — Dedup Guard segment-funnel 500 (⚠️ oblast 18)
**Soubor:** `features/platform/outreach-dashboard/src/server-routes/dedupGuard.js:149`  
**Příčina:** `WHERE c.segment_id = $1 AND c.is_deleted = FALSE` na tabulce `contacts` — sloupce neexistují.  
**Fix:** Použít `segment_memberships` tabulku nebo upravit dotaz na existující schéma.

### BLOCKER 4 — runMullvadEndpointReputationCron undefined (⚠️ oblast 16)
**Soubor:** `features/platform/outreach-dashboard/server.js:6127`  
**Příčina:** `scheduleCron('runMullvadEndpointReputationCron', ...)` volá funkci která není importována. Cron každých 6h crashuje se ReferenceError.  
**Fix:** Doplnit import funkce nebo odebrat ze scheduleCron dokud není implementována.

### BLOCKER 5 — Kampaň 457 estimate = 0 / scoring degraded (⚠️ oblasti 3+10)
**Příčina:** `send_events` nemá sloupec `company_id` — scoring preview padá do degraded fallback. Campaign estimate závisí na companies API (blocker 1).  
**Fix:** Po opravě blockeru 1 se obě oblasti stabilizují. `send_events.company_id` je přidán v pozdějších migracích — prověřit pending migraci.

---

## Datový stav po recovery — přehled

| Tabulka | Rows | Poznámka |
|---------|------|----------|
| contacts | 426 296 | OK |
| companies | 426 296 | OK, ale v_likvidaci/v_insolvenci NULL |
| campaigns | 13 | 1 produkční (457), 12 test ghost |
| campaign_contacts | 45 906 | kampaň 457 enrolled |
| crm_clients | 2 271 | import eway_xlsx_2026-05-12 |
| outreach_mailboxes | 2 | oba active, score 100 |
| email_templates | 1 | intro_machinery |
| icp_sectors | 9 | nace_prefixes NULL |
| operator_settings | 6 | seednuté správně |
| segments | 1 | Garaaage výkup techniky Fáze 1 |
| segment_memberships | 47 212 | OK |
| outreach_suppressions | 2 683 | OK |
| suppression_list | 1 728 | OK |
| send_events | 1 | 1 test send |
| scoring_config | 1 | weights={} — prázdný |
| outreach_contacts | 0 | legacy tabulka, nepoužívaná pro hlavní flow |
| outreach_companies | 0 | legacy tabulka |
| leads | 0 | normální |
| outreach_threads | 0 | normální |
| reply_inbox | 0 | normální |
| anonymity_test_messages | 0 | normální |
| synthetic_runs | 0 | normální |

---

*Audit provedl automatizovaný agent, 2026-05-12 09:05–09:15 UTC. Všechny curl výsledky jsou živé snapshoty lokálního BFF :18001 + Railway DB.*
