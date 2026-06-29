# ADR-001 — Outreach Dashboard Quality Primitives

**Status:** Accepted
**Date:** 2026-04-21

## Kontext

Audit stránky `/mailboxes` (2026-04-21) odhalil 39 bugs napříč třemi systémovými anti-pattern třídami:

1. **Silent catch** — `pool.query(UPDATE ...).catch(() => {})` na ~23 místech v `features/platform/outreach-dashboard/server.js`. DB zápis tiše selhal, UI dál ukazovalo úspěch. Žádný log, žádný alert, žádná stopa.
2. **Optimistic toast** — frontend po 200 OK zobrazil "Uloženo" i když backend vrátil `{ok: false, error}` v body. Toast lhal operátorovi.
3. **3-state widgets** — fetch hooky rozlišovaly jen `loading | data`, bez error větve. Když `/api/X` spadl, komponenta renderovala prázdný stav (no data) vizuálně nerozlišitelný od "žádné záznamy".

**Konkrétní operátorský dopad:** pokus o `PATCH /api/mailboxes/:id` po rotaci hesla vrátil 200, toast řekl "Uloženo", ale DB zápis selhal na constraint violation a heslo zůstalo staré. Při dalším pokusu o send — `535 5.7.8 incorrect credentials`. Operátor nevěděl, že UI lže, dokud sending path nezačal házet AUTH fails.

Stránky pod auditem: `/mailboxy`, `/protection`, `/schedule`, `/campaigns`. Patterny se opakují napříč celým dashboardem, takže oprava case-by-case by generovala technický dluh stejné třídy.

Projekt memory má záznam: `project_schrany_quality_debt.md` — 39 bugs, 3 anti-patterns, fix plan 2026-04-21.

## Rozhodnutí

Zavádíme **šest sdílených primitiv** pro outreach-dashboard, která eliminují tyto tři anti-pattern třídy u zdroje. Každý nový hook/endpoint/mutace MUSÍ jít skrz tato primitiva. Existující call-sites se postupně migrují (wave plan v iniciativě `2026-04-21-outreach-dashboard-quality-refactor.md`).

| Primitivum | Umístění | Účel |
|---|---|---|
| `useResource` | `features/platform/outreach-dashboard/src/hooks/useResource.js` | 4-stavový fetch hook (`idle \| loading \| data \| error`), nahrazuje ad-hoc `useEffect + useState` fetch v komponentách. Error je první-třídní stav, ne `null`. |
| `dbMutate` / `dbMutateDetached` | `features/platform/outreach-dashboard/src/lib/dbMutate.js` | Wrapper kolem `pool.query(...)` pro server BFF. `dbMutate` re-throws (HTTP path), `dbMutateDetached` logs-only (background). Oba zapisují do ring bufferu o kapacitě 100 záznamů. |
| `createJob` / `runJob` + `getJob` / `listJobs` | `features/platform/outreach-dashboard/src/lib/jobs.js` | Async job tracker: dlouhé operace (bulk assign-proxy, full-check × N) dostanou job ID, klient pollluje `/api/jobs/:id`. Bounded memory, TTL cleanup. |
| `createMailboxAlert` | `features/platform/outreach-dashboard/src/lib/mailboxAlerts.js` | Dedup helper nad `outreach_mailbox_alerts` — idempotent insert per `(mailbox_id, type, severity)` v 30min okně. Eliminuje duplikátní řádky z loop-based watchdogs. |
| `StaleIndicator` | `features/platform/outreach-dashboard/src/components/StaleIndicator.jsx` | UI badge "data z XYZ" pro surface, kde máme posledně-úspěšný snapshot ale aktuální fetch je error. Odliší "stará pravda" od "žádná pravda". |
| `getRelayBase` + `relayFetch` | `features/platform/outreach-dashboard/src/lib/relayClient.js` | Env-first config resolver pro anti-trace-relay URL. Priorita: `process.env.ANTI_TRACE_URL` > `outreach_config.anti_trace_url` row > hard default. Eliminuje hardcoded `localhost:8080` v 9 call-sites. |

**Operační observability:** `/api/health/write-errors` endpoint vystavuje ring buffer z `dbMutate`, takže operátor vidí v UI co za posledních 100 zápisů tiše selhalo.

## Důsledky

**Pozitivní:**
- Explicitní error UI — žádný tichý no-data stav; operátor vidí, že fetch/write selhal, s důvodem.
- Auditovatelné write failures přes `/api/health/write-errors` ring buffer (posledních 100, per-label + per-target + error code).
- Bounded jobs in-memory s TTL — dlouhé operace neblokují request-response cycle a nekradou serveru heap.
- Konzistentní alert dedup — jeden alert per `(mailbox, type, severity)` per okno místo spamu z loopu.
- Env-first config — deploy preview na jiný relay URL nevyžaduje DB hack.
- Test surface — primitiva mají vlastní unit testy (`useResource.test.jsx`, `dbMutate.test.js`, `jobs.test.js`, `mailboxAlerts.test.js`, `relayClient.test.js`), call-sites testují business logic, ne fetch plumbing.

**Negativní:**
- Více kódu na call-site (import + meta parametr) vs. inline `fetch` + `.catch(() => {})`. Verbose, ale intencionální.
- Job polling adds request churn — klient polluje `/api/jobs/:id` v 1–2s intervalech. Pro N současných jobů = N pollů. Akceptujeme, backend endpoint je O(1) hashmap lookup.
- Ring buffer je per-process — při restartu BFF ztrácíme historii write failures. Nepersisujeme do DB, protože by to byla rekurze (write failure do write failures tabulky může failnout).

**Neutrální:**
- Migrace existujících call-sites je post-hoc wave work, ne big-bang. Primitiva koexistují se starým kódem, dokud všechny stránky neprojdou auditem.

## Alternativy zvažované

- **React Query / TanStack Query / SWR** — overkill pro náš request volume (<100 req/s per klient), bundle cost (~13kb gzip) není zdarma, a tým preferuje vlastní úzce zaměřené hook-y bez abstraction leakage z cache invalidation layeru. Server state v dashboardu je tenký a většina mutací je single-endpoint — nic, co by SWR vyřešil líp než `useResource` + `dbMutate`.
- **Global error boundary only** — React error boundary chytne render-time exceptions, ale neřeší silent data loss: úspěšný render s vadným datem (např. toast "OK" po failed write) nevyvolá žádný throw. Error boundary je komplementární (ponecháváme), ne náhrada za explicitní 4-stavový fetch a write logging.
- **Promise.allSettled na call-sites místo ring buffer** — adresuje uncaught rejection, ale nedává operátorovi panel pro zpětný pohled "co za posledních N zápisů failnulo". Ring buffer v BFF procesu je ideální fit pro time-windowed diagnostics.
- **Přepsat BFF na Go** — odstranilo by dual-runtime problém (Node BFF + Go backend), ale je to disproportionální refactor vůči problému, který je o třech patterns, ne o volbě jazyka.
