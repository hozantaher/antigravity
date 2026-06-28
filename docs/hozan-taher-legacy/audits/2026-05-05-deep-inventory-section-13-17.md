# Deep inventory — sekce 13-17: Analytika, Watchdog, Observability, Anonymita, Dedup

**Status:** Dokončeno
**Datum:** 2026-05-05
**Trigger:** Pre-launch audit dashboard sekcí 13-17, otázky 297-389
**Scope:** Analytics.jsx, Watchdog.jsx, Observability.jsx, DiagnostikaAnonymita.jsx, DedupGuard.jsx + backing server-routes

Metodologie: každá otázka dostane jednu ze čtyř kategorií:
- `✓` — implementováno, code evidence
- `⚠` — částečně nebo s omezením
- `✗` — chybí, nenalezeno
- `NA` — not applicable pro tuto sekci

---

## 13. Analytika (`features/platform/outreach-dashboard/src/pages/Analytics.jsx`)

### A funkce

**297. KPIs zobrazené na hlavní stránce?**
`✓` — čtyři KPI karty: celkem odesláno, reply rate, open rate, bounce rate + aktivní kampaně.
`Analytics.jsx:248-267`

**298. Per-campaign metrics (open, click, reply, bounce)?**
`✓` — tabulka kampaní se sloupci sent/replied/opened/bounced, click chybí.
`Analytics.jsx:343-370` + `server.js:5804-5822`

**299. Per-mailbox metrics (deliverability, score)?**
`✗` — žádný endpoint `/api/analytics/mailbox*`; per-mailbox data jsou jen v Watchdog (počty) a DiagnostikaAnonymita (skóre). Analytics agreguje across all mailboxes.

**300. Per-segment metrics (size trend)?**
`✗` — endpoint `/api/analytics/overview` ani `/campaigns` nesegmentuje.

**301. Time series / sparklines?**
`✓` — SVG BarChart s hover tooltip; 3 metriky (sent/replied/opened), switchable.
`Analytics.jsx:9-104`

**302. Filter by date range?**
`⚠` — UI má `days=7/14/30/90` a `customFrom`/`customTo` date inputs. Backend `/api/analytics/timeline` přijímá pouze `?days=N` (max 90), `from`/`to` parametry **ignoruje** — query ignoruje `customFrom`/`customTo` z frontendu.
`Analytics.jsx:155-161` vs `server.js:5780-5802`

### B data

**303. Z jakých tables se agreguje (send_events, tracking_events, reply_inbox)?**
`✓` — `send_events` pro overview, timeline a campaigns. `tracking_events` ani `reply_inbox` nejsou použity.
`server.js:5761-5822`

**304. Cache TTL pro aggregations?**
`✗` — žádná cache; každý requeset spouští plný `COUNT(*) FILTER` scan nad `send_events`. Může být pomalé při velkém objemu.

### C mailing

**305. Real-time update po novém send?**
`✗` — žádný polling (`pollMs=0` v useResource default). Data se obnoví jen při manuálním refreshi (navigace pryč a zpět, nebo `Zkusit znovu` na error stav).

### D UX

**306. Klávesová zkratka?**
`✓` — CommandPalette fuzzy search `analytika`/`analytics stats` naviguje na `/analytics`. Žádná číslovková zkratka (Engineering group).
`CommandPalette.jsx:18`

**307. Export do CSV / PDF?**
`⚠` — CSV export je implementovaný pro timeline data.
`Analytics.jsx:167-179`
PDF export chybí.

### E edge

**308. Co když intelligence loop neběží?**
`⚠` — data pocházejí z `send_events`, ne z intelligence loop. Intelligence loop ovlivňuje `last_score`, nikoli send analytiku. UI ukáže stará data bez alertu.

**309. Co když data starší než 7 dní (retention)?**
`⚠` — backend endpoint nebere v úvahu retention cutoff. Dotaz jednoduše vrátí co je v DB. Žádná warning pro operátora.

### F persistence

**310. Filters přes session?**
`✗` — `days` a `customFrom/customTo` jsou local `useState`, nepersistují přes reload.

### G security

**311. Analytics dashboard public-link sharing?**
`✓` — všechny `/api/analytics/*` endpointy jsou za `createAuthMiddleware()` (X-API-Key required). Nejsou v `AUTH_EXEMPT`.
`authMiddleware.js:19-32` + `server.js:350`

### H audit

**312. analytics_view logged?**
`✗` — žádný zápis do `operator_audit_log` při čtení analytics dat.

### I integrace

**313. Lze drill-down z metrics na konkrétní seznam (např. "20 bouncí" → seznam)?**
`⚠` — klik na řádek kampaně naviguje do `/campaigns/:id`.
`Analytics.jsx:356`
Bounce KPI card nemá drill-down na konkrétní bounce události.

### J perf

**314. Heavy aggregation queries — caching?**
`✗` — žádná cache. `COUNT(*) FILTER` nad celou `send_events` tabulkou bez time cap (overview endpoint). Pro velký objem může trvat.

---

## 14. Upozornění / Watchdog (`features/platform/outreach-dashboard/src/pages/Watchdog.jsx`)

### A funkce

**315. Co se monitoruje?**
`⚠` — `watchdog_events` tabulka s `check_name`, `severity`, `message`, `auto_healed`. Check names: `stuck_campaign_contact`, `dissolved_enrolled`, `stale_email_domain`.
`Watchdog.jsx:7-11` + `server.js:2437-2452`
Anti-trace failures ani IMAP poller outages nejsou dedikované check_name hodnoty.

**316. Severity (critical, warning, info)?**
`✓` — tři úrovně: `critical`/`warn`/`info` s barevným dot.
`Watchdog.jsx:13`

**317. Lze alert manuálně close?**
`✗` — žádné tlačítko close/dismiss v UI.

**318. Lze alert snooze (suppress 1h)?**
`✗` — snooze neimplementován.

**319. Auto-close když problem resolves?**
`⚠` — `auto_healed` boolean field existuje, `auto_healed_24h` count v headeru.
`Watchdog.jsx:103-104` + `server.js:3252-3255`
Automatické zavření event záznamu ale neexistuje — zápisy do DB jsou append-only.

### B data

**320. alerts / alert_state table?**
`⚠` — tabulka `watchdog_events` (ne `alerts`/`alert_state`). Schema:
```
id, check_name, severity, entity_type, entity_id, message, auto_healed, healed_at, created_at
```
`server.js:2437-2452`

**321. Source: probes, healing log, intelligence loop?**
`⚠` — `watchdog_events` je plněna healing loopem (`runMailboxHealingCron`, `runCampaignWatchdogCron`). Intelligence loop ani anti-trace probes do ní nepíší přímo.
`server.js:1574-1587`

### C mailing

**322. Alert at "mailbox bounce rate > 5%"?**
`✓` — `runCampaignWatchdogCron` pauzuje kampaň při `bounceRate > 0.05` a loguje healing event.
`server.js:4695-4698`

**323. Alert at "anti-trace queue depth > 100"?**
`✗` — žádný check na anti-trace queue depth.

**324. Alert at "no IMAP poll for 1h"?**
`✗` — IMAP poller je v orchestratoru (Go), ne v BFF watchdogu. Watchdog UI nesleduje IMAP poll latency.

### D UX

**325. Klávesová zkratka?**
`✓` — CommandPalette `watchdog health monitoring`.
`CommandPalette.jsx:19`

**326. Toast notifications real-time?**
`✗` — žádný polling ani SSE; data se načtou jednou při mount. Reload tlačítko existuje.
`Watchdog.jsx:97-98` (useResource bez pollMs)

**327. Per-source filter (mailbox vs anti-trace vs IMAP)?**
`✗` — žádný filtr po check_name/source.

### E edge

**328. Storm of alerts — rate limit per source?**
`✗` — žádný rate-limit na vkládání do `watchdog_events`.

**329. Alert deduplication?**
`✗` — žádná deduplication logika; stejný event může být vložen opakovaně.

### F persistence

**330. Snooze persists přes reload?**
`NA` — snooze neexistuje.

### G security

**331. Alerts globální nebo per-operator?**
`⚠` — `/api/health/watchdog` je v `AUTH_EXEMPT` — **veřejně čitelné bez API klíče**.
`authMiddleware.js:22`
Events jsou globální (ne per-operator).

### H audit

**332. alert_close, alert_snooze logged?**
`NA` — close/snooze neexistují.

### I integrace

**333. Z alertu navigovat na příčinu (např. mailbox detail)?**
`✗` — `EventRow` zobrazuje text, ale neklikatelný odkaz na mailbox detail.
`Watchdog.jsx:62-84`

### J perf

**334. Polling interval pro nové alerts?**
`✗` — žádný polling. Ruční refresh button.

---

## 15. Pozorovatelnost (`features/platform/outreach-dashboard/src/pages/Observability.jsx`)

### A funkce

**335. Logs streaming (Sentry, Railway logs)?**
`✗` — žádné live log streaming. Stránka ukazuje synthetic run mřížku + burn rate + test quality.

**336. Daemons status (campaign_daemon, intel_loop)?**
`⚠` — cron heartbeats jsou dostupné přes `/api/health/cron-heartbeats` (health.js:113-134), ale Observability.jsx je nevykresluje. Stránka netáhne `/api/health/cron-heartbeats`.

**337. Cron job last_run timestamps?**
`✗` — Observability.jsx nevolá `/api/health/cron-heartbeats`. Dostupné na `/api/health/cron-heartbeats` ale nepoužité.

**338. Health snapshot (DB, anti-trace, IMAP, BFF)?**
`⚠` — `/api/health/system` vrací proxy pool + watchdog stale status.
`health.js:157-181`
Observability.jsx ho ale nevolá přímo; tyto dat jsou jen v `useResource('/api/health/invariants')`.

**339. Anti-trace egress diagnostic?**
`✗` — Observability.jsx neobsahuje anti-trace egress metriky.

**340. Sentry release tag?**
`✗` — žádná Sentry release badge ani link na Observability stránce.

### B data

**341. /api/health/system response — co obsahuje?**
`✓` — `proxy_pool_size`, `proxy_pool_low`, `egress_mode`, `watchdog_stale`, `last_watchdog_at`, `alerts[]`.
`health.js:157-181`

**342. /dashboard endpoint Go orchestrator?**
`⚠` — `/api/operator-metrics` proxuje na Go `/operator-metrics`. Observability.jsx tento endpoint nevolá.

### C mailing

**343. Per-pipeline-step success rate?**
`✗` — není implementováno na Observability stránce.

**344. Bottleneck identification?**
`✗` — není implementováno.

### D UX

**345. Real-time auto-refresh?**
`⚠` — `useDashboardMetrics()` hook používá SSE (`/api/dashboard/metrics-stream`) s polling fallbackem.
`Observability.jsx:74`, `useDashboardMetrics.js:11`
Synthetic runs grid ale není live — žádný pollMs.

**346. Drill-down do log entries?**
`✗` — synthetic run rows ukazují count failures, ale žádný drill-down do konkrétních failure zpráv.
`Observability.jsx:135-146`

### E edge

**347. Co když Go service down — UI graceful degradation?**
`⚠` — `useResource` falluje na `status='error'` se zobrazeným error textem. Dashboard metrics hook má SSE→polling fallback.

### F persistence

**348. Sentry replay link?**
`✗` — žádný Sentry replay link.

### G security

**349. Logs nemají PII?**
`✓` — synthetic_runs tabulka ukládá test výsledky (pass/fail counts), ne PII data.
`server.js:5357-5370`

### H audit

**350. observability_view audit log?**
`✗` — žádný zápis do `operator_audit_log`.

### I integrace

**351. Linkuje na Sentry, Railway dashboards?**
`✗` — žádné external links na stránce.

### J perf

**352. Dashboard load time pod 1s?**
`⚠` — stránka dělá 3 fetch volání (`/api/synthetic-runs`, `/api/health/invariants`, `/api/health/test-quality`) + SSE stream pro dashboard metrics. Bez cachování, ale data jsou malá.

---

## 16. Diagnostika anonymity (`features/platform/outreach-dashboard/src/pages/DiagnostikaAnonymita.jsx`)

### A funkce

**353. Per-message anonymity score (L1 IP / L2 fingerprint / L3 envelope / L4 DKIM-SPF-DMARC)?**
`⚠` — anonymityLatest.js agreguje `anonymity_score` a `humanlike_score` z `anonymity_test_messages`. UI zobrazuje avg/min skóre a top leaks se `rule` + `severity`. L1-L4 breakdown není explicitně kategorizovaný v UI.
`anonymityLatest.js:55-179`

**354. Histogram skóre přes recent sends?**
`✗` — žádný histogram. Jen avg a min za 7 dní.
`anonymityLatest.js:115-120`

**355. Per-mailbox average anonymity?**
`✓` — `GET /api/anonymity/all` vrací jeden záznam per active mailbox s `avg_score`/`min_score`.
`anonymityLatest.js:209-221`

**356. Detail view jednoho výsledku?**
`✓` — Drawer komponenta s `top_leaks` tabulkou + `top_telltales` tabulkou + recommendation string.
`DiagnostikaAnonymita.jsx:101-273`

**357. Trend v čase?**
`✗` — žádný time trend; pouze 7-denní okno.

### B data

**358. anonymity_test_messages table?**
`✓` — tabulka existuje (migrations 022+023+024).
`anonymityLatest.js:21` (comment), migrace ověřeny: `022_anonymity_test_messages.sql`, `023_anonymity_scores.sql`, `024_anonymity_humanlike_scores.sql`

**359. Migrations 022 + 023 + 024?**
`✓` — soubory existují v `scripts/migrations/`.

### C mailing

**360. Real production sends scored automaticky? Nebo jen test sends?**
`✗` — `anonymity_test_messages` je plněna 4-binary chainem (`anonymity-test` → `anonymity-harvest` → `anonymity-score` → `anonymity-humanlike`). Produkční sends nejsou automaticky scored — jen on-demand přes "Spustit test" tlačítko.
`anonymityLatest.js:244-258`

**361. Threshold pro alert (skóre < 40 = warning)?**
`⚠` — UI thresholds: `>=85` zelená, `70..84` žlutá, `<70` červená. Alert při `<40` není zvlášť implementován.
`DiagnostikaAnonymita.jsx:30-35`

### D UX

**362. Search by run_id?**
`✗` — žádný search/filter UI.

**363. Filter per-mailbox per-template?**
`✗` — žádný filter. Stránka zobrazuje vždy všechny aktivní schránky.

### E edge

**364. mb-to-mb ceiling 60/100 (memory mb_to_mb_anonymity_ceiling)?**
`✓` — viz memory `mb_to_mb_anonymity_ceiling`: Seznam internal hop neemituje L3+L4 receiving headers, takže mb-to-mb max je 60/100. UI to nekomentuje, ale recommendation string to implicitně pokrývá.

**365. mb-to-Gmail (full L3+L4 viditelnost)?**
`✓` — dual-axis test chain (`anonymity-test`) posílá mb-to-mb a Engine→Gmail. Drawer zobrazuje detaily.

### F persistence

**366. Filters přes reload?**
`NA` — žádné filtry.

### G security

**367. Diagnostic data jen operator?**
`✓` — `/api/anonymity/all` a `/api/anonymity/run` nejsou v `AUTH_EXEMPT`.
`authMiddleware.js:19-32`

### H audit

**368. anonymity_test_run logged?**
`✗` — POST `/api/anonymity/run` nezapisuje do `operator_audit_log`.
`anonymityLatest.js:225-260`

### I integrace

**369. Linkuje na anonymity-test cmd output?**
`✗` — žádný link na raw cmd výstup z UI.

**370. Linkuje na mailbox detail (per-mailbox score)?**
`✗` — Drawer zobrazuje email jako plain text, neklikatelný odkaz na `/mailboxes/:id`.
`DiagnostikaAnonymita.jsx:146-151`

### J perf

**371. Aggregations cached?**
`✗` — `GET /api/anonymity/all` dělá N+1 query (jednu per aktivní mailbox) sekvenčně.
`anonymityLatest.js:211-220`
Žádná cache.

---

## 17. Dedup Guard (`features/platform/outreach-dashboard/src/pages/DedupGuard.jsx`)

### A funkce

**372. 8 axes (PR #832): dnt, lifetime_exhausted, cross_campaign, per_domain, bounce_cluster, region_rate_limit, engagement_decay, crm_active_client?**
`✓` — všech 8 os definovaných v `AXIS_INFO` + `axesOrder`.
`DedupGuard.jsx:9-50`
Backend SQL dotaz vrací všech 8 sloupců.
`dedupGuard.js:40-106`

**373. Per-segment funnel (eligible → blocked breakdown)?**
`✓` — 5-krokový funnel: total → after_dnt → after_lifetime → after_cooldown → after_crm.
`DedupGuard.jsx:93-150` + `dedupGuard.js:113-193`

**374. Recent skips list (PII redacted per PR #841)?**
`✓` — `recent-skips` vrací contact_id (ne email), campaign_id, reason, skipped_at. Email explicitně vynechán.
`dedupGuard.js:197` (komentář) + `dedupGuard.js:204-224`

**375. Per-axis statistics (hit count last 24h / 7d)?**
`⚠` — `GET /api/dedup-guard/stats` vrací **celkový** lifetime count per osu bez time window.
`dedupGuard.js:27-111`
"Last 24h / 7d" filtrování chybí.

### B data

**376. campaign_contacts.details JSONB skip_reason?**
`✓` — migration 049 přidala `campaign_contacts.details JSONB` + index `(details->>'skip_reason')`.
`049_dedup_guard.sql:75-78`
SQL dotaz filtruje `details->>'skip_reason' LIKE 'dnt%'` atd.
`dedupGuard.js:44-81`

**377. contacts.dnt + lifetime_touches + email_domain (migrace 049)?**
`✓` — migration 049 přidala všechna tři pole + triggery.
`049_dedup_guard.sql:19-69`

### C mailing

**378. Real-time po každém runner tick?**
`✗` — žádný polling. useResource default bez pollMs.
`DedupGuard.jsx:206-207`

**379. Pre-launch verification (jeden ze 4 sanity gates)?**
`⚠` — DedupGuard UI je monitoring panel, ne aktivní gate. Skutečný enforcement je v Go `sender/dedup_guard.go`.
`features/outreach/campaigns/sender/dedup_guard.go`

### D UX

**380. Klávesová zkratka?**
`✓` — CommandPalette `dedup guard blocking suppression` → `/dedup-guard`.
`CommandPalette.jsx:20`

**381. Manual override (operator unblock contact)?**
`✗` — žádné tlačítko "odblokovat". Čistě read-only panel.

### E edge

**382. Co když 0 contactů blokováno (test segment)?**
`✓` — `AxisTile` zobrazuje `0` s CheckCircle ikonou (muted tone).
`DedupGuard.jsx:52-91`

**383. Co když 100% contactů blokováno (chyba v config)?**
`⚠` — funnel ukáže `eligible=0`, UI to vizuálně zobrazí (červená progress bar). Žádný explicit warning banner.

### F persistence

**384. Filter persists?**
`⚠` — `selectedSegment` (číslo) je local state, nepersistuje. DedupGuard nemá jiné filtry.

### G security

**385. Recent skips email redacted (PII memory)?**
`✓` — endpoint vrací jen `contact_id` (int), nikoli email adresu.
`dedupGuard.js:204-224`

### H audit

**386. dedup_guard_init, dedup_guard_update logged?**
`✗` — žádný zápis do `operator_audit_log` v dedupGuard.js routes.

### I integrace

**387. Z guard panelu otevřít contact detail (proč přesně blokován)?**
`✗` — `SkipEventRow` zobrazuje `C#<id>`, ale neklikatelný odkaz na `/contacts/:id`.
`DedupGuard.jsx:152-188`

**388. Z guard panelu modifikovat config (threshold)?**
`✗` — žádná konfigurace thresholdů z UI. Config je pouze v `DefaultDedupGuardConfig()` v Go.
`features/outreach/campaigns/sender/dedup_guard.go:66`

### J perf

**389. Aggregations TTL?**
`✗` — žádná cache. Stats jsou live SQL COUNT per request.

---

## Souhrn verdiktů

| Sekce | ✓ | ⚠ | ✗ | NA | Celkem |
|-------|---|---|---|----|----|
| 13. Analytika (297-314) | 6 | 4 | 8 | 0 | 18 |
| 14. Watchdog (315-334) | 4 | 4 | 10 | 2 | 20 |
| 15. Observability (335-352) | 2 | 5 | 10 | 0 | 17 (+ duplicity) |
| 16. DiagnostikaAnonymita (353-371) | 7 | 4 | 8 | 1 | 20 |
| 17. DedupGuard (372-389) | 7 | 4 | 7 | 0 | 18 |
| **Celkem** | **26** | **21** | **43** | **3** | **93** |

---

## MVP blockers (kritické pro zítřejší launch)

### KRITICKÉ

1. **Analytics custom date range nefunguje** — `customFrom`/`customTo` jsou odesílány jako URL params ale backend `server.js:5780-5802` je ignoruje (pouze `?days=N`). Operátor uvidí nesprávný rozsah. Ref: Q302.

2. **Watchdog: `/api/health/watchdog` je v AUTH_EXEMPT** — endpoint je veřejně čitelný bez API klíče.
   `authMiddleware.js:22`. Watchdog UI čte from `/api/health/watchdog` (inline, `server.js:3236-3270`) i z health.js:184-211 — existují **dvě** route registrace pro stejnou cestu! Express keeps the first. Ref: Q331.

3. **AnonymityLatest: N+1 queries** — `GET /api/anonymity/all` dělá sekvenční query per active mailbox. Se 4 mailboxy zanedbatelné, ale pattern je špatný. Ref: Q371.

4. **Produkční sends nejsou automaticky scored** — anonymity scoring je jen on-demand (tlačítko "Spustit test"). Pro kontinuální monitoring anonymity potřeba scheduler. Ref: Q360.

5. **DedupGuard: axes statistics nemají time window** — stats endpoint vrací cumulative lifetime count, ne "last 24h". Operátor nevidí dnešní aktivitu. Ref: Q375.

### STŘEDNÍ (pre-launch žádoucí)

6. **Watchdog: žádné close/snooze alertů** — append-only model. Operátor nevidí "vyřešeno". Q317, Q318.

7. **Observability: cron heartbeats nevykresleny** — endpoint existuje ale UI ho nevolá. Q336-337.

8. **DedupGuard: contact ID není klikatelný** — skip list ukazuje C#id ale bez linku. Q387.

9. **Analytics: žádný per-mailbox breakdown** — není per-mailbox deliverability přehled. Q299.

10. **Žádná audit log pro analytics/observability/anonymity viewing** — Q312, Q350, Q368, Q386.
