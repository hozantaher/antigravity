# server.js Route Inventory — D2.1 Decomposition Catalog

**Date**: 2026-05-03  
**File**: `features/platform/outreach-dashboard/server.js` (7507 LoC)  
**Total Routes**: 116 (excluding middleware)  
**Status**: Read-only analysis for D2.2–D2.6 sprint sequencing

---

## Executive Summary

- **116 routes** distributed across **34 domain groups**
- **Top 5 groups** account for **6,320 LoC** (84% of handler volume)
- **replies.js already extracted** as pattern reference; mount point at line 7085
- **mailboxes** (34 routes, 3269 LoC) and **health** (40 routes+, 2872 LoC) are extraction priorities
- **High-value groups** for D2.2–D2.4: companies, mailboxes, scoring, templates, segments

---

## Route Inventory by Group

| Group | Routes | Line Range | Est. LoC | Avg/Handler | Priority | Notes |
|-------|--------|-----------|----------|-------------|----------|-------|
| **mailboxes** | 34 | 1963–5230 | 3,269 | 96* | HIGH | Largest group; health checks, warmup, alerts, proxies, tests. Many sub-endpoints. |
| **health** | 4–40** | 4309–7179 | 2,872 | 71 | HIGH | Watchdog, protections, proxy sources, auto-recover; spans multiple sections. |
| **companies** | 15 | 363–1216 | 855 | 57 | HIGH | Stats, facets, verification, scoring, facts, lookalike; dense clustering. |
| **scoring** | 6 | 1230–1396 | 168 | 28 | MEDIUM | Config, preview, recompute, learn; discrete unit. |
| **protections** | 5 | 2648–2762 | 116 | 23 | MEDIUM | Matrix, trace, alerts, coverage; operational surface. |
| **contacts** | 5 | 4891–4994 | 105 | 21 | MEDIUM | CRUD + verify-email; compact. |
| **templates** | 6 | 1853–1949 | 98 | 16 | MEDIUM | CRUD + preview, ranking; isolated. |
| **meta** | 4 | 1432–1514 | 84 | 21 | MEDIUM | Categories tree/search; utility group. |
| **segments** | 5 | 1547–1612 | 67 | 13 | MEDIUM | CRUD + preview, rebuild; data dependency. |
| **analytics** | 3 | 7008–7054 | 47 | 15 | LOW | Overview, timeline, campaigns; read-only. |
| **cohorts** | 1 | 897 | 16 | 16 | LOW | Single lookup endpoint. |
| **diagnostics** | 2 | 1127–1149 | 23 | 11 | LOW | Segmentation, feature-lift; observational. |
| **anti-trace** | 2 | 2598–2636 | 39 | 19 | LOW | Health, egress; proxy diagnostics. |
| **dns-audit** | 1 | 2369 | 185 | 185 | MEDIUM | Complex single audit endpoint. |
| **suppression** | 4 | 5002–5054 | 53 | 13 | MEDIUM | GET/POST/DELETE; legacy + suppressions. |
| **dashboard** | 2 | 4180–4203 | 24 | 12 | LOW | Metrics stream; real-time feed. |
| **enrichment** | 1 | 1167 | 11 | 11 | LOW | Refresh plan trigger. |
| **version** | 1 | 2358 | 11 | 11 | LOW | Version check. |
| **lookalike** | 1 | 1096 | 31 | 31 | LOW | Centroid lookup. |
| **dual-axis** | 1 | 1000 | 97 | 97 | LOW | Dual-axis query endpoint. |
| **email-verification** | 1 | 1413 | 20 | 20 | LOW | Stats only. |
| **synthetic-runs** | 1 | 2201 | 28 | 28 | LOW | Reads synthetic test history. |
| **proxy-pool** | 2 | 2553–2559 | 7 | 3 | LOW | Trend + live pool. |
| **metrics** | 1 | 2149 | 53 | 53 | LOW | Mailbox metrics aggregation. |
| **scraper** | 1 | 6940 | 69 | 69 | LOW | Healing diagnostics. |
| **healing** | 2 | 6888–6901 | 14 | 7 | LOW | Log + stats. |
| **__schema-check** | 1 | 1756 | 98 | 98 | MEDIUM | Schema parity with Go; cached. |

**Notes:**
- *malboxes avg/handler is high due to nested conditional logic within handlers; actual line cost varies 10–200 per route.
- **health group spans scattered sections (watchdog, protections, proxy-sources); line range is loose estimate.
- **replies.js** (already extracted): registered at 7085; covers `/api/threads/stream`, `/api/replies/*`, `/api/operator/*`, `/api/leads/*` (NOT tabulated here; see separate mount).

---

## Group Dependencies & Extraction Bottlenecks

### Mailboxes (34 routes)
- **Depends on**: PostgreSQL pool, `pool.query()`, Go backend proxy (POST `/api/campaigns/:id/run`, etc.)
- **Internal deps**: `src/lib/outreachApi.js` (Go proxy), `src/lib/mailboxChecks.js` (SMTP/IMAP), `src/lib/proxyRotation.js`
- **Extraction risk**: HIGH — entangled with health checks, watchdog polling. Recommend extract health-check subgroup first.
- **Suggested split**: `src/routes/mailboxes/[crud|health|warmup|checks].js` (4 sub-modules)

### Health (40 internal routes, mixed sections)
- **Depends on**: Sentry, proxyPool, protections, Go backend
- **Internal deps**: `src/lib/outreachHealth.ts` (Zustand store consumer), `src/lib/protections.js`
- **Extraction risk**: MEDIUM — will expose the fragmented line-range issue.
- **Suggested split**: Consolidate scattered sections into one module: `src/routes/health.js`

### Companies (15 routes)
- **Depends on**: PostgreSQL pool, Go backend (schema check), `src/lib/scoringEngine.js`
- **Extraction risk**: LOW — concentrated in 363–1216; few external deps.
- **Suggested split**: `src/routes/companies.js` as single export.

### Scoring (6 routes)
- **Depends on**: Go backend, `src/lib/scoringEngine.js`
- **Extraction risk**: LOW — discrete unit.
- **Suggested split**: `src/routes/scoring.js`

### Templates (6 routes)
- **Depends on**: PostgreSQL pool, `src/lib/contentRender.js` (preview)
- **Extraction risk**: LOW — isolated, no cross-dependencies.
- **Suggested split**: `src/routes/templates.js`

---

## Pre-Existing Pattern Reference

**File**: `src/routes/replies.js` (extracted, 350+ LoC)

**Mount pattern**:
```javascript
app.use(createRepliesRouter(pool, safeError))
```

**Structure**:
- Exports default function `createRepliesRouter(pool, safeError)`
- Uses `Router()` from Express
- Each `router.get/post/patch/delete()` inline in file
- Dependencies: pool, safeError utility, rewriteCidUris, capture500

**Copy this pattern for D2.2–D2.6 extractions**.

---

## Extraction Sequencing Recommendation (D2.2–D2.6)

### Phase 1: High-value, low-risk (D2.2–D2.3)
1. **Companies** (15 routes, 855 LoC) — isolated, dense
2. **Templates** (6 routes, 98 LoC) — no entanglement
3. **Scoring** (6 routes, 168 LoC) — Go backend boundary clear

### Phase 2: Medium-value, medium-risk (D2.3–D2.4)
4. **Segments** (5 routes, 67 LoC) — requires careful data dependency mapping
5. **Contacts** (5 routes, 105 LoC) — CRUD pattern
6. **Meta/Categories** (4 routes, 84 LoC) — utility layer

### Phase 3: High-value, high-risk (D2.4–D2.6)
7. **Mailboxes** (34 routes, 3269 LoC) — extract health checks first, then bulk operations, then individual checks
8. **Health** (4+ routes, 2872 LoC) — consolidate scattered sections, then extract

### Defer (D2.7+)
- **Analytics, diagnostics, protections** — read-only observational; lower priority unless UI refactor.
- **Anti-trace, DNS audit** — operational endpoints; stable, low-churn.

---

## Implementation Checklist (per extraction)

- [ ] **Search before extract**: verify `mcp__claude-context__search_code` for cross-references in other files
- [ ] **Isolate dependencies**: list all imported utilities, pool calls, Go proxies
- [ ] **Test coverage**: preserve or expand unit tests for each route
- [ ] **Type check**: run `pnpm tsc` after extraction
- [ ] **Mount point**: ensure new Router is registered at server.js line 7085 (after existing middleware)
- [ ] **PR citation**: reference this inventory SHA in PR description (cite commit of this file)
- [ ] **Contract test**: verify `bff-operator-approval.contract.test.ts` still passes

---

## File Statistics

```
Total server.js: 7507 LoC
Middleware/setup: ~1000 LoC
Route handlers: ~6500 LoC
Extractable: ~5500 LoC (83%)
Remaining (middleware, error handling): ~1000 LoC
```

---

Generated by CAD-A2 session, 2026-05-03.
