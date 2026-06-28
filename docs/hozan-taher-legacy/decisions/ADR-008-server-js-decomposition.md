# ADR-008 — server.js monolith decomposition strategy

**Status:** Accepted
**Date:** 2026-04-30
**Supersedes:** —
**Related:**
- [Code health inventory](../audits/2026-04-30-deep-inventory-code.md) — finding #1 (8744 LoC monolith)
- [Synthesis optimization plan](../audits/2026-04-30-synthesis-optimization-plan.md) — Tier 3 server.js decomp
- Memory: `project_autonomous_dev_north_star` aspirace #8 (self-documenting decisions)

## Kontext

`features/platform/outreach-dashboard/server.js` má **8744 řádků kódu** s **154 routes a 95 funkcí** (per code health inventory PR #427). Single největší tech debt v projektu.

Dnešní rozsah souboru:
- Auth middleware
- Rate-limit middleware (3 paralelní mechanismy, částečně konsolidováno PR #426)
- DSR endpoints (`/api/dsr/access`, `/api/dsr/erase`)
- Privacy endpoint
- Unsubscribe endpoint (const-time fixed PR #408)
- Campaign lifecycle endpoints (`/api/campaigns/*`)
- Mailbox endpoints (`/api/mailboxes/*`)
- Reply endpoints (`/api/replies/*`, `/api/threads/*`)
- Companies + leads + segments endpoints
- Health surface aggregator
- Cron jobs (8+ via `timed()` wrapper)
- Operator approval endpoints (PR #426 just landed: `/api/operator/queue` + `/approve` + `/companies/:id/timeline`)
- Schema parity check
- Sentry tunnel
- Suppression read/write
- AI suggestion pipeline hook (post-IMAP-poll)
- ... ~30 dalších route groupings

Monolithic structure způsobuje:
1. **Code review friction** — diff přes 8000+ řádků pro malou změnu
2. **Test isolation problem** — celý server.js loading even pro single-route test
3. **Cognitive overload** — operator v auditu nesnadno najde ownership per route
4. **Merge konflikt frequency** — vysoká, paralelní agenti často sahají do server.js

Single attempt na big-bang extract failed (T2.6 prvý pokus, agent timeout na 10+ min při manipulaci se 8744-LoC souborem).

## Rozhodnutí

### D1 — Per-route-module incremental extract

Rozdělit `server.js` postupně do **8 route modulů** v `features/platform/outreach-dashboard/src/server-routes/`. Každý modul exportuje single `mountXxxRoutes(app, deps)` funkci. server.js se redukuje na thin orchestrator co volá mounters v sekvenci.

**Není** big-bang refactor. Per-PR jeden modul. Každý PR ≤500 LoC delta. Single commit per PR.

### D2 — Module breakdown (8 plánovaných extracts)

| Order | Module | LoC odhad | Endpoints | Sprint |
|---|---|---|---|---|
| 1 | `dsr.js` | ~250 | /api/dsr/access, /api/dsr/erase | T2.6 v2 (already in flight) |
| 2 | `unsubscribe.js` | ~150 | /unsubscribe (link click) + /api/unsubscribe | T3.1 |
| 3 | `privacy.js` | ~80 | /privacy serving | T3.2 |
| 4 | `health.js` | ~200 | /healthz + /api/health/* aggregator | T3.3 |
| 5 | `campaigns.js` | ~600 | /api/campaigns/* (lifecycle) | T3.4 |
| 6 | `mailboxes.js` | ~500 | /api/mailboxes/* | T3.5 |
| 7 | `replies.js` | ~700 | /api/replies, /api/threads, /api/operator/queue | T3.6 |
| 8 | `companies-leads.js` | ~600 | /api/companies, /api/leads, /api/segments | T3.7 |

**Po 8 extractech**: server.js redukován z 8744 → ~3500 LoC (auth middleware + cron + boot + thin orchestrator). To už je manageable.

### D3 — Behavior preservation = byte-equivalent contract tests

Každý extract MUSÍ projít existing contract tests beze změny:
- `tests/contract/bff-*.contract.test.ts` — všechny per-endpoint testy
- `tests/audit/gdpr-cascade-shape.test.js` — DSR cascade discipline
- Snapshot test `api-route-inventory.snapshot.test.ts` — route count
- E2E `tests/e2e/*.spec.ts` — happy path

Per memory `feedback_search_before_implement`: extract = REUSE existing handler, ne rewrite. Closure capture pro shared state (dbPool, auditLog).

### D4 — Mounter signature konvence

```javascript
// features/platform/outreach-dashboard/src/server-routes/<module>.js
export function mountXxxRoutes(app, { db, auditLog, ... }) {
  app.get('/api/xxx', async (req, res) => { ... })
  // ...
}
```

server.js orchestrator:
```javascript
import { mountDsrRoutes } from './src/server-routes/dsr.js'
import { mountUnsubscribeRoutes } from './src/server-routes/unsubscribe.js'
// ...
const deps = { db: dbPool, auditLog, ... }
mountDsrRoutes(app, deps)
mountUnsubscribeRoutes(app, deps)
// ...
```

### D5 — Sprint sequencing dependency

| Sprint | Závisí na | Důvod |
|---|---|---|
| T2.6 v2 (DSR) | — | Independent, in flight |
| T3.1 unsubscribe | T2.6 v2 (precedent) | Same pattern |
| T3.2 privacy | T2.6 v2 | Tiny scope, easy |
| T3.3 health | T3.2 | health aggregates from /api endpoints |
| T3.4 campaigns | T3.3 | Largest scope, leverage prior patterns |
| T3.5 mailboxes | — | Independent |
| T3.6 replies | T3.4 (campaigns) | Reply context references campaigns |
| T3.7 companies-leads | T3.4 | Lead funnel ties to campaigns |

**Phase order:** T2.6 → T3.1 → T3.2 → T3.3 → (T3.4 || T3.5 paralelně) → T3.6 → T3.7

Estimated: **8 PRs across 6-8 týdnů** (1 PR/week pace, conservative pro behavior preservation).

## Důsledky

### Pozitivní

- server.js LoC ↓ 8744 → 3500 (~60% redukce)
- Per-route owner clarity — discoverable
- Test isolation — single module loadable
- Lower merge konflikt frequency
- Per memory `feedback_efficient_execution` — bundle related, ale incremental ne big-bang

### Negativní

- 8 PRs ceremony cost (~5 min/PR ceremony × 8 = 40 min)
- Mid-state during decomp: server.js + některé moduly = mental overhead
- Possible regression risk per extract (mitigováno contract tests)

### Neutrální

- Test count nepřímo affected (tests nezávislé na where handler je)
- Build time ↓ marginally (smaller chunks možný code-split)

## Recovery procedura

Pokud po extract některý contract test red:

1. **Identifikuj selhání** — který endpoint, jaký response shape change
2. **Revert PR** přes `git revert <merge-sha>` na main
3. Re-extract s narrower scope nebo bug fix
4. **Pokračuj sequence** od dalšího sprintu

## Rejected alternatives

### A — Big-bang extract (single PR)

Rejected (T2.6 prvý pokus): 8744 LoC operation timeoutuje agent capacity. Risk regression je vysoký pokud single PR mění 8 modulů najednou.

### B — Direct route declaration in main app

Rejected: server.js zůstává monolit, jen reorganizace. Žádný měřitelný benefit.

### C — Switch to Express Router-based per-file

Rejected: Express Router adds indirection (mount path prefixes) co rozbíjí existing `app.X('/api/...', ...)` patterny. Mounter funkce zachovají existing route declaration shape exactly.

## Implementation plan

| Sprint | Obsah | Status |
|---|---|---|
| T2.6 v2 | DSR routes extract | in flight |
| T3.1 | Unsubscribe routes | M+1 |
| T3.2 | Privacy routes | M+1 |
| T3.3 | Health routes | M+1 |
| T3.4 | Campaigns routes | M+2 |
| T3.5 | Mailboxes routes | M+2 (parallel s T3.4) |
| T3.6 | Replies routes | M+2-3 |
| T3.7 | Companies/leads/segments | M+3 |

## Reference

- Code health inventory PR #427: server.js LoC + endpoint count
- Synthesis PR #428 Tier 3 entry
- Existing pattern: `features/platform/outreach-dashboard/src/components/` modulization (UI side already done)
