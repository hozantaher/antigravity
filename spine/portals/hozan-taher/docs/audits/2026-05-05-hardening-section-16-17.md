# Audit — Pages 16-17: Diagnostika anonymity + Dedup Guard
**Status:** Completed
**Datum:** 2026-05-05
**Trigger:** Agent 5 hardening pass — brutal test, edge cases, new features, critical fixes

---

## Scope

| Page | File | Server route |
|------|------|--------------|
| 16 — Diagnostika anonymity | `src/pages/DiagnostikaAnonymita.jsx` | `src/server-routes/anonymityLatest.js` |
| 17 — Dedup Guard | `src/pages/DedupGuard.jsx` | `src/server-routes/dedupGuard.js` |

---

## Critical Fixes Applied (PR #hardening/pages-16-17)

### Fix 1: limit=0 quirk in /api/dedup-guard/recent-skips
**Before:** `parseInt(req.query.limit) || 100` — undocumented, limit=0 silently becomes 100.
**After:** Behavior preserved but explicitly documented in comments. Contract test 20 now explicitly locks the behavior. `rawLimit` variable named for clarity.

### Fix 2: N+1 in /api/anonymity/all
**Before:** Sequential per-mailbox DB queries — 1 query for active mailboxes list + N×3 queries = O(N) DB round trips.
**After:** Single batch query fetches all scored rows for all active mailboxes. Per-mailbox fallback only fires for mailboxes with no recent scored rows (typically 0). Added `buildAggregateFromRows()` helper that processes pre-fetched rows in memory without additional DB calls. New contract tests: 10b, 10c.

### Fix 3: DedupGuard stats cumulative without time-window
**Before:** `/api/dedup-guard/stats` always returned cumulative all-time counts. No way to see recent trends.
**After:** New `?window=all|24h|7d|30d` query parameter. Default = `all` (backward compatible). `window` value echoed in response. Invalid window → 400. UI exposes 4 window buttons. New contract tests: 22–26.

---

## Polish Applied

### Diagnostika anonymity
1. **Threshold alert banner** — fires when any mailbox `anonymity.avg_score` or `humanlike.avg_score` < 40. Lists affected emails. `data-testid="threshold-alert-banner"`.
2. **Critical row highlighting** — rows below threshold get `data-critical="true"` + light red background + alert icon next to email.
3. **Score overview panel in drawer** — 2-column grid showing avg/min/messages for both dimensions side by side.
4. **Layer breakdown in drawer** — leaks grouped by L1/L2/L3/L4 prefix when detected. Falls back to flat table for rules without prefix. `data-testid="leak-layer-L1"` etc.
5. **Runs count in drawer** — `last_7_days_runs` displayed in drawer header.

### Dedup Guard
1. **Time-window selector** — 4 buttons (Vše / 24h / 7d / 30d) above axis grid. Re-fetches stats with `?window=` param on click. Active button highlighted.
2. **"Why was this contact blocked?" lookup** — New `ContactBlockLookup` component. Takes contact ID, calls `/api/dedup-guard/contact-block-reason?id=N`. Shows active suppressions + skip history. PII-safe: no email returned.
3. **Axis tile test IDs** — `data-testid="axis-tile-{axis}"` added to each tile.
4. **Segment input test ID** — `data-testid="segment-id-input"`.
5. **Skip row test ID** — `data-testid="skip-event-row"`.

---

## New API Endpoint

### GET /api/dedup-guard/contact-block-reason?id=N
Returns: `{ contact_id, company_name, domain, skip_history[], active_suppressions[] }`
PII constraint: no email field in response (contact_id only).
Contract tests: 27–34.

---

## Test Summary

| Suite | Tests before | Tests added | Tests after |
|-------|-------------|-------------|-------------|
| DiagnostikaAnonymita.test.jsx (unit) | 21 (13–21) | 9 (22–30) | 30 |
| DedupGuard.test.jsx (unit) | 0 | 18 (1–18) | 18 |
| anonymity-latest.contract.test.ts | 12 (1–12) | 2 (10b, 10c) | 14 |
| dedup-guard.contract.test.ts | 21 (1–21) | 13 (22–34) | 34 |
| **Total** | **33** | **42** | **66** |

---

## Deferred Features (filed as GH issues)

See issues filed with labels `enhancement` + `mvp-deferred`:
- Per-mailbox per-template trend chart
- Comparison view (template A vs B) for anonymity
- Per-message drill-down in anonymity drawer
- Manual unblock button for contacts in Dedup Guard
- Threshold config UI (operator-configurable score thresholds)
- Per-segment funnel breakdown with axis overlay

---

## Bypass Risk Assessment
No pipeline code changed. BFF-only changes (Express routes + React UI).
Anti-trace pipeline not touched.
