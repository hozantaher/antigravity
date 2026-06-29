# BFF Self-Healing — Plán + Sprints

Plán pro **autonomní samoléčení BFF/dashboard vrstvy**. Doplňuje [`MAILBOXES-SELF-HEALING-SPRINTS.md`](MAILBOXES-SELF-HEALING-SPRINTS.md), které řeší mailbox-layer recovery; tento dokument se zaměřuje na **tichá selhání infrastruktury** — zastaralý cache, mrtvé cron cykly po restartu, konfigurační drift, proxy ECONNREFUSED, chybějící watchdog heartbeat.

Cíl: **Operátor nepotřebuje kontrolovat, jestli systém běží.** Chyby, které jsme v dubnu 2026 řešili ručně (clear anti_trace URL, advance warmup, kill stale BFF, reassign dead proxy, insert heartbeat, re-trigger pipeline) se musí detekovat a opravit samy.

## Guiding principles

1. **Robustnost > feature.** Každá vrstva opravuje skutečný incident z historie session — nic spekulativního.
2. **Reverzibilita.** 4 sprinty = 4 commity; každý lze otočit bez ztráty dat.
3. **Audit trail.** Každá auto-heal akce jde do `watchdog_events` s `auto_healed=true` + `reason`.
4. **Fail-open.** Pokud stale detector selže, systém pracuje dál — žádný hard dependency na healeru.
5. **Skutečný signál > kosmetika.** UI banner/badge ukáže jen stav, který reálně brzdí sending.

## Současný stav (snapshot 2026-04-20)

**Co funguje:**
- Proxy pool rozšířen na CZ + sousední země (8 zemí), EU filter, COUNTRY_RANK (S1 hotovo).
- Mailbox watchdog daemon (Go) běží 5 min cyklus (S2 hotovo).
- Circuit breaker per-mailbox, canary mode, metrics endpoint (S5 hotovo).
- AnonymizationBar rozlišuje `not_configured` vs `DOWN` (tone-muted).

**Identifikované mezery — incident log z této session:**
1. **Stale BFF proces** — starý PID 13837 držel port bez `/api/daemons`, `/api/health/system`. Nikdo to nehlídá.
2. **Anti-trace UI false DOWN** — prázdný `anti_trace_url` v DB hlásil červené. Opraveno ručně (`UPDATE outreach_config SET value=''`).
3. **Dead proxy pinned** — `206.123.156.232:7005` ECONNREFUSED na mailbox 3; auto-swap neběžel, reassign ručně.
4. **Watchdog tabulka prázdná** — UI banner "watchdog tichý"; ručně insert heartbeat.
5. **Warmup stale 45h** — `last_advanced_at` 2 dny starý, ručně `UPDATE mailbox_warmup SET warmup_day=warmup_day+1`.
6. **Pipeline stale 45h** — POST `/api/mailboxes/:id/pipeline-test` manuálně.
7. **Vite port mismatch** — `.ts` na 3100, `.js` na 3001; žádná detekce driftu.
8. **Proxy refresh po restartu** — BFF boot neznamená refresh pool; čeká na cron.
9. **Git SHA nezjistitelný** — operátor neví, jestli běží aktuální build.
10. **Mailbox score freeze** — skóre 41 držel celou dobu, bez auto-recovery action z BFF strany.
11. **BFF nepíše do watchdog_events** — veškerá telemetrie závislá na Go watchdog; pokud spadne, ticho.

**Společný pattern:** *tichý zastaralý stav* — data jsou, ale nikdo nehlídá jejich čerstvost. Self-healing v2 přidá **guards** (kontroluje TTL stavu) + **recovery hooks** (pouští chybějící cycle) + **BFF heartbeat** (nezávislý signál).

## Architektura — 6 vrstev

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: StaleDetector (guards)                            │
│  └─ GUARDS = {                                              │
│       proxy_pool:         30 min  → refresh                 │
│       watchdog_heartbeat: 10 min  → insert heartbeat        │
│       anti_trace:          5 min  → re-probe / mute         │
│       pipeline_results:   24 h    → trigger pipeline-test   │
│       warmup_advance:     26 h    → advance warmup          │
│       mailbox_proxy:      15 min  → verify alive            │
│     }                                                       │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: StartupRecovery  (catch-up na boot)               │
│  └─ BFF start → projdi GUARDS, dožeň vše expired            │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: ProxyReassignGuard  (error middleware)            │
│  └─ ECONNREFUSED na mailbox proxy → blacklist + reassign    │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: ConfigDriftCheck  (startup + /api/health/drift)   │
│  └─ vite.config duplicates, port mismatch, bad URLs         │
├─────────────────────────────────────────────────────────────┤
│  Layer 5: WatchdogFromBFF  (60s heartbeat)                  │
│  └─ insert do watchdog_events i když Go daemon spadl        │
├─────────────────────────────────────────────────────────────┤
│  Layer 6: MailboxAutoRecover  (6h cron)                     │
│  └─ score<50 & no recent recover → auto "Recover now"       │
└─────────────────────────────────────────────────────────────┘
```

## Sprinty

### S1 — StaleDetector + StartupRecovery + git-SHA

**Scope:** `features/platform/outreach-dashboard/server.js`, nový modul `features/platform/outreach-dashboard/staleGuard.js`.

**Cíl:** Detekovat zastaralé stavy a spustit recovery — na boot i každých 60 s.

**Změny:**
- Nový `staleGuard.js` s `GUARDS` configem (table výše) a funkcí `runGuards()`.
- Každý guard má `{ name, ttlMs, check(), recover(), reason }`.
- `check()` vrací `{ stale: boolean, lastAt: Date }` (čte z DB / cache / endpoint).
- `recover()` pouští chybějící cycle (např. `refreshProxyPool()`, `POST /api/mailboxes/:id/pipeline-test`, `advanceWarmup()`).
- Každé auto-recovery zapíše `watchdog_events` row s `auto_healed=true, reason='stale_guard:<name>'`.
- **StartupRecovery:** při BFF bootu zavolat `runGuards()` synchronně (fail-open — log warn, pokud guard hodí chybu).
- **Periodic:** `setInterval(runGuards, 60_000)`.
- Nový endpoint `GET /api/version` → vrátí `{ git_sha, built_at, pid, uptime_s }` (čte přes `execSync('git rev-parse HEAD')` s cache).
- Nová migrace `migrations/040_bff_boot_log.sql`: `bff_boot_log (id, started_at, git_sha, pid, guard_results JSONB)` — audit, co guardy udělaly na boot.

**Acceptance:**
- Restart BFF → do 2 s v logu `[staleGuard] recovered: proxy_pool, warmup_advance` pokud byly expired.
- `GET /api/version` vrací aktuální SHA z `git rev-parse HEAD`.
- `SELECT * FROM bff_boot_log ORDER BY started_at DESC LIMIT 1` zachytí boot + recovery report.
- Mrtvá proxy / stará warmup / chybějící heartbeat — do 60 s auto-fix, event v `watchdog_events`.
- Žádný guard nespadne (even jeden selhávající neblokuje ostatní) — try/catch per-guard.
- Build green, `pnpm test` green.

**Estimated touch:** ~200 LOC (120 staleGuard.js + 60 server.js + 20 migrace).

**Revert:** `git revert <sha>`; migrace idempotentní, tabulka může zůstat.

---

### S2 — ProxyReassignGuard

**Scope:** `features/platform/outreach-dashboard/server.js` — error handler kolem SMTP check / full-check / actual send endpointů.

**Cíl:** Když mailbox proxy ECONNREFUSED/ETIMEDOUT → automaticky blacklist + swap + retry. Dnes se hází 500, operátor musí ručně reassign.

**Změny:**
- Nový helper `proxyReassignGuard(mailboxId, err, retryFn)` v `server.js`:
  1. Detekuje síťovou chybu (`ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`, proxy-level `407`).
  2. Přidá aktuální `proxy_url` do `proxy_blacklist` tabulky (TTL 6 h).
  3. Zavolá `/api/mailboxes/:id/assign-proxy` s `exclude=<current>`.
  4. Zavolá `retryFn()` jednou; pokud znovu selže — nechá error probublat.
  5. Loguje `watchdog_events` `auto_healed=true, reason='proxy_reassign:<old>→<new>'`.
- Integrace do tří endpointů: `/api/mailboxes/:id/smtp-check`, `/api/mailboxes/:id/full-check`, `/api/mailboxes/:id/send-test`.
- Nová migrace `migrations/041_proxy_blacklist.sql`: `proxy_blacklist (proxy_url PK, mailbox_id, blacklisted_at, expires_at, reason)`.
- `assignProxy()` musí respektovat blacklist (filtr z `proxy_pool.working[]`).

**Acceptance:**
- Simulace: ručně UPDATE mailbox proxy na neexistující `1.2.3.4:9999` → zavolat `/api/mailboxes/:id/smtp-check` → odpověď po reassign success, nový proxy jiný než `1.2.3.4:9999`.
- `SELECT * FROM proxy_blacklist` obsahuje starou adresu.
- Pokud 2 reassign podkrk selžou (proxy pool prázdný) → error 503 bez nekonečné smyčky.
- Žádný retry loop > 1 per request.

**Estimated touch:** ~100 LOC (70 guard + 20 endpoint wiring + 10 migrace).

**Revert:** `git revert <sha>`; `proxy_blacklist` tabulka může zůstat.

---

### S3 — ConfigDriftCheck + `/api/health/drift` + UI banner

**Scope:** nový modul `features/platform/outreach-dashboard/configDrift.js`, `server.js` endpoint, `src/pages/Mailboxes.jsx` banner.

**Cíl:** Detekovat konfigurační chyby (vite duplicates, port mismatch, bad URLs) dřív, než dojde k incidentu.

**Změny:**
- `configDrift.js` s checks:
  - **Vite configs:** existuje `vite.config.ts` i `vite.config.js` → warn (source of truth ambiguous).
  - **Port consistency:** `CORS_ORIGIN` host/port = skutečný Vite dev port (z `npm pkg get scripts.dev` nebo env).
  - **Backend reachability:** `GO_SERVER_URL` odpovídá na `/health` do 2 s.
  - **Anti-trace URL:** pokud `outreach_config.anti_trace_url` neprázdný → HEAD check; prázdný = `not_configured` (muted).
  - **Proxy pool health:** `working.length >= 5`.
  - **Watchdog freshness:** poslední `watchdog_events` < 10 min.
- Nový endpoint `GET /api/health/drift` → `{ ok: boolean, drifts: [{ severity, check, message, detected_at }] }`.
- Běží při startu + každých 5 min.
- UI banner nad Mailboxes: `if (!drift.ok && drift.drifts.some(d => d.severity === 'critical'))` → sticky červený.
- CSS: nová třída `.config-drift-banner` s tone-err.

**Acceptance:**
- Smazat `vite.config.js` nebo `.ts` → restart → `GET /api/health/drift` vrátí `ok:true` bez duplicate warn.
- Zavřít Go backend → do 5 min banner ukazuje `backend_unreachable`.
- Proxy pool drop na 2 → banner `proxy_pool_low`.
- `not_configured` stavy jsou `severity: info` — neukazují banner.
- Banner zmizí do 30 s po recovery.

**Estimated touch:** ~150 LOC (90 configDrift.js + 30 server.js + 30 Mailboxes.jsx/CSS).

**Revert:** per-file checkout.

---

### S4 — WatchdogFromBFF + MailboxAutoRecover

**Scope:** `server.js` — dva nové intervaly, integrace s existujícím `watchdog_events`.

**Cíl:**
1. BFF píše vlastní heartbeat do `watchdog_events` — nezávislé na Go daemonu. Pokud Go spadne, UI pořád vidí živý signál.
2. Mailboxy se score <50 po 6 h bez recovery akce dostanou auto "Recover now".

**Změny:**
- `watchdogFromBFF()` běží každých 60 s:
  - `INSERT INTO watchdog_events (check_name, severity, message, auto_healed) VALUES ('bff_heartbeat', 'info', 'BFF alive', false)`.
  - Throttle: jen 1 řádek za 10 min (neroste tabulka lineárně).
- `mailboxAutoRecover()` běží každých 6 h:
  - `SELECT id, score FROM mailboxes WHERE status='active' AND score < 50`.
  - Pro každý: zkontroluj `watchdog_events WHERE mailbox_id=? AND auto_healed=true AND created_at > now() - interval '12 hours'`.
  - Pokud žádný recent auto-heal → zavolat interně `/api/mailboxes/:id/recover-now`.
  - Event: `auto_healed=true, reason='auto_recover:score_<N>'`.
- Respektovat circuit breaker z S5 předchozího plánu — pokud mailbox v `auth_circuit=open`, skip (nečekané volání by resetovalo breaker).
- `/api/health/watchdog` už vrací `{ last_event_at }` — S4 jen zajistí, že se plní i bez Go daemonu.

**Acceptance:**
- Kill Go daemon → UI watchdog chip stále zelený (BFF píše sám).
- Ručně `UPDATE mailboxes SET score=30 WHERE id=<test>` → do 6 h `auto_recover` event + score stoupne.
- `SELECT count(*) FROM watchdog_events WHERE check_name='bff_heartbeat' AND created_at > now() - interval '1 hour'` ≤ 7 (throttle works).
- `mailboxAutoRecover` neběží pro schránky v bounce_hold nebo auth_circuit=open.

**Estimated touch:** ~200 LOC (120 server.js + 80 test helpers/fixtures).

**Revert:** feature flag `BFF_AUTO_RECOVER=0` → skipped; heartbeat běží default.

---

## Cross-sprint checklist

Před každým commitem:
- [ ] `cd features/platform/outreach-dashboard && pnpm build` green
- [ ] `cd features/platform/outreach-dashboard && pnpm test` green
- [ ] `go test ./...` green (pokud sprint zasahuje Go — v tomto plánu nemá)
- [ ] Manuální test: restart BFF → `curl /api/version` vrátí SHA, `curl /api/health/drift` vrátí `{ok:true}`
- [ ] `watchdog_events` neroste > ~10 řádků/hodinu při idle
- [ ] `proxy_blacklist` má expires_at cleanup (pokud S2 hotové)
- [ ] Žádný nový TODO/FIXME v novém kódu
- [ ] `git diff --stat` sanity check

## Out of scope

- **Auth / RBAC pro `/api/health/*`** — interní BFF, zatím bez login.
- **Prometheus scraping** — metrics endpoint už existuje z předchozího S5; nerozšiřujeme.
- **Slack/Discord alerting** — ruční log file sledování stačí.
- **Multi-tenant isolation** — singleton operátor, zatím netřeba.
- **Go-side duplikace guards** — Go watchdog už existuje, tento plán pokrývá BFF mezeru, ne duplicitu.
- **Migrace na TypeScript** — server.js zůstává JS, nerozjíždíme transpile.

## Session references

- **Incident log:** tato session (2026-04-20), 11 ručních zásahů zdokumentováno výše.
- **Předchozí mailbox sprinty:** [`MAILBOXES-SELF-HEALING-SPRINTS.md`](MAILBOXES-SELF-HEALING-SPRINTS.md) S1–S5 (hotové).
- **Hlavní zdroje:**
  - `features/platform/outreach-dashboard/server.js` — BFF, proxy pool, endpointy.
  - `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx` — UI banner, AnonymizationBar.
  - `features/platform/outreach-dashboard/src/index.css` — tone-muted, tone-err.
  - `modules/outreach/internal/watchdog/*.go` — existující Go watchdog.
- **DB migrations dir:** `modules/outreach/migrations/` (Go), `features/platform/outreach-dashboard/migrations/` (nová — vytvořit v S1).
- **Revert base:** commit `cc9b467` on `wm/new-features`.

## Prioritní pořadí

Doporučené pořadí implementace podle impact/risk:

| # | Sprint | Impact | Risk | Deps |
|---|---|---|---|---|
| 1 | **S1 StaleDetector + StartupRecovery + git-SHA** | Velmi vysoký | Nízký | žádné |
| 2 | **S2 ProxyReassignGuard** | Vysoký | Nízký | S1 (blacklist migrace pattern) |
| 3 | **S3 ConfigDriftCheck** | Střední | Nízký | S1 (endpoint style) |
| 4 | **S4 WatchdogFromBFF + MailboxAutoRecover** | Vysoký | Střední | S1 (guards log), S2 (reassign) |

**Quick wins** (S1, S3) lze dodat do 1 dne; **core** (S2, S4) jsou 1–1.5 dne každý včetně testů.

**Celkem:** ~650 LOC, 4 commity, 2 SQL migrace (`040_bff_boot_log.sql`, `041_proxy_blacklist.sql`).
