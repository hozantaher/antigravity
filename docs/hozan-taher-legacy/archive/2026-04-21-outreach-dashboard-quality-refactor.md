**Status:** Archived
**Datum:** 2026-04-21
**Trigger:** Dashboard quality audit identified 39 bugs (5 waves); work folded into brownfield pass + master plan

# Outreach Dashboard Quality Refactor — 39 bugs, 3 anti-patterns, 5 waves

**Vlastník:** Chat A (primitives + migration) + Chat B (kontraktní testy + regresse)
**Datum uzavření:** —

**Souvisí s:** [ADR-001 — Outreach Dashboard Quality Primitives](../decisions/ADR-001-outreach-dashboard-quality-primitives.md)

## Kontext

Audit `/mailboxy` (2026-04-21) odhalil 39 bugs napříč třemi anti-pattern třídami:

1. **Silent catch** — ~23× `pool.query(UPDATE ...).catch(() => {})` v `server.js`. DB write tiše padl, UI dál ukazovalo úspěch.
2. **Optimistic toast** — frontend rendroval "Uloženo" po 200 OK i když body mělo `{ok: false}`.
3. **3-state widgets** — fetch hooky neměli error state, render byl vizuálně shodný s "no data".

Operátor viděl "success" UI v okamžiku, kdy DB write skončil na constraint violation. První stopu zachytil až sending path (`535 AUTH fail`), což je příliš pozdě a příliš nepřímé.

Projekt memory: `project_schrany_quality_debt.md` (viz MEMORY.md). Audit je authoritative seznam, waves níže jsou implementační plán.

## Cíle

1. **W0: Primitiva existují + mají testy** — šest primitiv z ADR-001, každé s unit testy ≥80 % cov. ✅ splněno.
2. **W1: Žádná "critical lie"** — všechny toasty & UI success stavy odpovídají reálnému výsledku backend callu.
3. **W2: Žádný silent DB write** — všechny `pool.query()` UPDATE/INSERT volání jdou přes `dbMutate`/`dbMutateDetached`.
4. **W3: Konzistentní UX** — všechny fetch surface na `/mailboxy`, `/protection`, `/schedule` používají `useResource` 4-stavový model + `StaleIndicator` pro posledně-známý snapshot.
5. **W4: Polish** — dlouhé operace mají job tracker, alerty jsou deduplikované, relay URL je env-first.

## Plán (sprinty / waves)

### W0 — Primitiva (hotovo, 2026-04-21)

- [x] `useResource` hook + testy — `features/platform/outreach-dashboard/src/hooks/useResource.js` + `useResource.test.jsx`
- [x] `dbMutate` / `dbMutateDetached` + ring buffer + testy — `features/platform/outreach-dashboard/src/lib/dbMutate.js` + `dbMutate.test.js`
- [x] Job tracker (`createJob`, `runJob`, `getJob`, `listJobs`) + testy — `features/platform/outreach-dashboard/src/lib/jobs.js` + `jobs.test.js`
- [x] `createMailboxAlert` dedup helper + testy — `features/platform/outreach-dashboard/src/lib/mailboxAlerts.js` + `mailboxAlerts.test.js`
- [x] `StaleIndicator` komponenta — `features/platform/outreach-dashboard/src/components/StaleIndicator.jsx`
- [x] `getRelayBase` + `relayFetch` + testy — `features/platform/outreach-dashboard/src/lib/relayClient.js` + `relayClient.test.js`
- [x] `/api/health/write-errors` endpoint vystavuje ring buffer

**Exit:** všech 6 primitiv nasazeno v `wm/development`, vitest green, primitiva dokumentovaná v ADR-001.

### W1 — Critical lies (hotovo, 2026-04-21)

Prioritou jsou UI surface, kde operátor dělá destruktivní akce a věří úspěšnému toastu.

- [x] Mailbox edit (`PATCH /api/mailboxes/:id`): toast vázán na response body `ok` flag, ne jen na HTTP 200.
- [x] Password update: po rotaci se volá `full-check` a toast agreguje SMTP+IMAP result, ne předpokládá OK.
- [x] Campaign pause/unpause: response body `{paused: bool}` se propaguje do Zustand store, UI čte autoritativní stav.
- [x] Assign-proxy: toast renderuje `{tried, summary, attempts}` breakdown, ne "Úspěch".
- [x] Bulk actions: partial-success (část selhala) ukazuje red+green split, ne jeden success toast.

**Exit:** grep `// TODO: toast lies` = 0, manuální smoke test všech CRUD na `/mailboxy` a `/campaigns`.

### W2 — Data integrity (hotovo, 2026-04-21)

Všechny silent catches na `server.js` → `dbMutate*`.

- [x] Audit writes (healing_log, watchdog_events) → `dbMutateDetached`
- [x] Konfigurace (outreach_config UPDATE) → `dbMutate` (throws, HTTP path)
- [x] Schedule state (paused_until) → `dbMutate`
- [x] Mailbox proxy assignment persist → `dbMutate`
- [x] Alert inserts přes `createMailboxAlert` (dedup) místo raw INSERT
- [x] `/api/health/write-errors` endpoint vrací posledních 100 failures

**Exit:** `grep -n "\.catch(() => {})" server.js` = 0 na prod path, UI banner na `/schrany` když `write-errors` vrátí nenulový počet za posledních 15 min.

### W3 — UX consistency (rozpracováno)

Fetch surface migrace na `useResource` + `StaleIndicator`.

- [x] `/mailboxes` hlavní tabulka — `useResource` + error row
- [x] Ochrany panel (protection matrix 12×2) — `useResource`, skip rows jako 1st-class state
- [x] Pool trend sparkline — `useResource` + `StaleIndicator` když refresh fail
- [ ] `/schedule` kalendář — stále na ad-hoc `useEffect`, čeká migrace
- [ ] `/campaigns` list + detail — migrace po dokončení preflight UI (T-U01 v outreach-unblock)
- [ ] Settings page — nižší priorita, nízký traffic

**Exit:** všech 5 hlavních stránek používá `useResource`; žádný komponent nemá ručně psaný `const [data, setData]` + fetch.

### W4 — Polish (částečně)

- [x] Bulk assign-proxy používá `runJob` + `/api/jobs/:id` polling místo 30s request timeoutu
- [x] `getRelayBase` nasazen v 9 call-sites; `ANTI_TRACE_URL` env var respektován
- [x] Pool trend + health widget s `StaleIndicator` pro posledně-úspěšný snapshot
- [ ] `/api/jobs` cleanup ticker (TTL 1h) — implementován, ale e2e test s klokem zbývá
- [ ] Alert dedup coverage audit — `createMailboxAlert` nasazen, ale ne všechna stará INSERT místa migrovala

**Exit:** všechny dlouhé operace (>5s) jsou jobs, ne blocking requests; alert dedup pokrývá všechny watchdog loopy.

## Blokátory

- **Go-side audit pending:** anti-pattern třídy (silent catch, optimistic response) existují symetricky v `modules/outreach/` Go kódu. Wave plán pro Go side zatím neexistuje, potřeba samostatná iniciativa po dokončení W3.
- **Test coverage:** Chat B čeká na W3 dokončení, než bude psát kontraktní testy nad `/api/health/write-errors` shape a `/api/jobs/:id` polling protokolem.

## Rizika

- **Ring buffer memory:** 100 záznamů × ~500B = ~50kB per process. Neroste, acceptable. Pokud se cap zvedne, review.
- **Job polling load:** při ≥10 současných jobs (např. bulk operace nad 1000 mailboxes) dává ~10 pollů/s. Endpoint je O(1) lookup, ale sledovat v metrics.
- **StaleIndicator fatigue:** když backend je dlouho dole, všechny widgety ukazují "stará data z X min". Operátor zvykne ignorovat. Mitigace: agregovaný banner "Backend unreachable N min" místo N individuálních badges.

## Log

- 2026-04-21 — založeno, W0 primitiva hotová (6/6), W1 + W2 completed in same session, W3 ~60 % (3/5 stránek), W4 částečně. ADR-001 sepsán.

## Follow-ups

- **T-Q01** — Go-side audit: projít `modules/outreach/` na ekvivalentní anti-pattern třídy (ignored err, optimistic HTTP response) a založit paralelní iniciativu.
- **T-Q02** — Dokončit W3 migraci `/schedule` a `/campaigns` na `useResource`.
- **T-Q03** — Chat B: kontraktní test `/api/health/write-errors` response shape + `/api/jobs/:id` lifecycle (pending → running → done/error).
- **T-Q04** — E2E test `runJob` + poll protokol (vitest nebo Playwright, uncertain fit — decide when writing).
- **T-Q05** — Settings page migrace (low priority).
- **T-Q06** — Review alert dedup coverage — migrate zbývající raw `INSERT INTO outreach_mailbox_alerts` přes `createMailboxAlert`.
- **T-Q07** — Operational runbook do `docs/playbooks/` — "jak číst `/api/health/write-errors` když operátor vidí podivný stav".
