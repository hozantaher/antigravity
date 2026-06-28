# server.js D2 Remainder Inventory (2026-05-03)

**Status:** Stabilization hold after PR #661/#666 incidents. Sequential extraction protocol applies.

## Current State

- **server.js size:** 6,619 LoC
- **Inline route count:** 73 (unchanged since D2.9)
- **Mounter modules wired:** 19 total; 18 active (runPreflight: 0 refs)

## Per-Domain Breakdown (Inline Routes)

| Domain | Count | Priority | Notes |
|--------|-------|----------|-------|
| `/api/mailboxes` | 35 | HIGH | 17% of all inline; largest extraction target |
| `/api/segments` | 5 | MEDIUM | Clean domain, stable |
| `/api/health` | 4 | LOW | 6 refs via mounter (over-instrumented) |
| `/api/suppression` | 3 | MEDIUM | Paired with `/api/suppressions` (refs) |
| `/api/categories` | 3 | MEDIUM | Isolated routes |
| `/api/analytics` | 3 | MEDIUM | Stable |
| `/api/threads` | 2 | LOW | Paired with replies mounter |
| `/api/healing` | 2 | LOW | Operator internal |
| `/api/diagnostics` | 2 | LOW | Dev/debug |
| Others (1 each) | 9 | LOW | Version, metrics, scraper, etc. |

## Unwired/Stub Modules

- **runPreflight:** 0 refs (exists; never imported)
- **anonymityLatest, bulkPassword, morningReadiness, operatorMetrics, templatePreview:** All wired exactly 1×; no inline duplicates detected ✓

## Risk Assessment

1. **No orphaned stubs** — all mounter files actively referenced or intentionally isolated
2. **Mailboxes 35-route cluster** requires sequencing (split risk: parallel extraction today caused #661/#666)
3. **Segments 5-route group** safe for immediate extraction (no dependencies on mailboxes)

## Recommended D2.10+ Sequence (Sequential, not parallel)

1. **Extract `/api/segments`** → `segments.js` mounter
2. **Split `/api/mailboxes`** into two modules (routes 1–18, 19–35) over two PRs
3. **Merge segments PR, then start mailboxes batch 1**
4. Clean remaining singletons (health instrumentation, diagnostics) in final pass

**Total remaining inline after D2.10:** ~38 routes (segments extraction clears 5; mailboxes split = 2 PRs = 0 net but isolated context)

**Estimated final state:** ~3,500–4,000 LoC in server.js; 0 inline routes.

---

**Incident lessons:** Parallel mounter work on overlapping domains triggers import conflicts. Sequential extraction with per-PR verification required until subsystem stability improves.
