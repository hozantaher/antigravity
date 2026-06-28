# Hardening Audit — Sales Pipeline Pages 9–12

**Status:** Done  
**Date:** 2026-05-05  
**Trigger:** Multi-phase hardening sprint (A: brutal tests, B: edge cases, C: new features, D: polish + new feature implementation)  
**Scope:** Leady (Leads), Skórování (Scoring), CRM Klienti (CrmClients)

---

## Phase A: Brutal Test Audit — Existing Coverage Gaps

### Leads.jsx

**Existing coverage (T-0260..T-0270):** 12 tests — happy path, status filter, density toggle, campaign link.

**Critical gaps found:**

| Gap | Risk | Severity |
|-----|------|----------|
| No test for API 500 response | Error state branch untested | HIGH |
| No test for PATCH 400 / 404 response | Error toast path untested | HIGH |
| No test for null contact_name | Crash risk on dirty data | HIGH |
| No test for `?status=contacted` / `?status=qualified` URL pre-filter | URL state incomplete | MEDIUM |
| No test for `patchLead` sending correct id for non-first row | Bug risk in id indexing | HIGH |
| No test for large list (50 rows) | Performance/render regression | MEDIUM |
| No test for leads with unknown status value | Defensive coding gap | LOW |
| No test for retry button after error | Retry path untested | MEDIUM |

**New tests added:** 30 (T-H001..T-H030 in `Leads.hardening.test.jsx`)

### Scoring.jsx / scoring.js

**Existing coverage (scoring.test.js + property.test.js):** 36 + 14 = 50 tests.

**Critical gaps found:**

| Gap | Risk | Severity |
|-----|------|----------|
| No test for `computeCompositeScore({})` (empty object) | Crash on missing fields | HIGH |
| No test for `email_confidence=NaN` | Silent 0 or NaN propagation | HIGH |
| No test for `email_confidence=-100` (invalid range) | Clamp behavior untested | MEDIUM |
| No test for `email_confidence=200` (over max) | Clamp behavior untested | MEDIUM |
| No exact boundary tests for scoreTier at 80/79, 65/64, 45/44, 25/24 | Off-by-one risk | HIGH |
| No test for ALL 6 axis keys in `axes_raw` | API contract gap | MEDIUM |
| No test for `penalties` object structure | Drawer rendering gap | MEDIUM |
| No test for `DEFAULT_WEIGHTS` frozen (immutability) | Silent mutation risk | HIGH |
| Fatigue penalty `recent_60d_count=-5` not tested | Defensive coding gap | LOW |

**New tests added:** 44 (SH-001..SH-i04 in `scoring.hardening.test.js`)

### CrmClients.jsx

**Existing coverage (E2E only):** 1 E2E spec, no unit tests.

**Critical gaps found:**

| Gap | Risk | Severity |
|-----|------|----------|
| No unit test for loading / empty / error states | UI regression risk | HIGH |
| No unit test for filter chip toggle (activate/deactivate) | Filter regression | HIGH |
| No unit test for drawer open/close lifecycle | UX regression risk | HIGH |
| No unit test for freshness banner (stale / never_imported / dismiss) | Banner logic untested | HIGH |
| No unit test for pagination (prev disabled on page 1) | Pagination regression | MEDIUM |
| No unit test for detail drawer 404 error state | Error path untested | HIGH |
| No unit test for linked companies/contacts in drawer | Data rendering gap | MEDIUM |

**New tests added:** 30 (CC-H001..CC-H030 in `CrmClients.hardening.test.jsx`)

---

## Phase B: Edge Cases

### pipelineValue.js (new utility)

Implements pipeline value forecast for Leads page stat strip.

**Tests added:** 22 (PV-001..PV-030 in `pipelineValue.test.js`)

Key invariants tested:
- Empty / null input → 0 (no crash)
- All 7 status values mapped correctly
- Weighted pipeline value (probability × deal value)
- CZK formatting with `Intl.NumberFormat`

### scoringBreakdown.test.js (new)

Per-axis breakdown panel helper tests.

**Tests added:** 20 (SB-001..SB-020)

Key invariants tested:
- `axes_raw` completeness (all 6 axes present)
- `penalties` object structure
- `buildAxisBreakdown` sorting by contribution
- Weight=0 axis shows percentage=0

### crmExport.js (new utility)

CSV export for CRM Clients filtered view.

**Tests added:** 30 (CE-001..CE-030 in `crmExport.test.js`)

Key invariants tested:
- RFC 4180 CRLF line endings
- Proper escaping of commas, double-quotes, newlines
- Null field handling → empty string
- Filename date-stamping

---

## Phase C: New Features Identified

### Leady (Leads)

| Feature | Priority | GH Issue |
|---------|----------|----------|
| Pipeline value forecast in stat strip | TOP | #proposed-lead-pipeline-value |
| Follow-up reminder ("připomenout za 7 dní") | P2 | mvp-deferred |
| Lead notes inline editor | P2 | mvp-deferred |
| Kanban board with drag-and-drop stages | P3 | mvp-deferred |
| Per-source breakdown chart | P3 | mvp-deferred |

### Skórování (Scoring)

| Feature | Priority | GH Issue |
|---------|----------|----------|
| Per-axis breakdown panel (visual bar chart per axis) | TOP | #proposed-scoring-axis-breakdown |
| Score histogram distribution (existing TierHistogram ✓) | Already done | — |
| Recalculate manual button (existing ✓) | Already done | — |
| Top 100 leads quick view | P2 | mvp-deferred |
| Scoring config version diff viewer | P3 | mvp-deferred |

### CRM Klienti (CrmClients)

| Feature | Priority | GH Issue |
|---------|----------|----------|
| Excel export filtered view | TOP | #proposed-crm-csv-export |
| Import history audit log view | P2 | mvp-deferred |
| CRM client → company link verification | P2 | mvp-deferred |
| Timeline (from import to last activity) | P3 | mvp-deferred |
| Reminder when client comes up for renewal | P3 | mvp-deferred |

---

## Phase D: Implemented (TOP 5 Polish + TOP 1 New Feature)

### TOP 5 Polish

1. **Leads brutal test suite** — 30 new test cases, filling all HIGH/MEDIUM gaps
2. **Scoring lib hardening** — 44 new test cases including boundary precision, immutability, NaN handling
3. **CRM Clients unit tests** — 30 new test cases (0 → 30, first unit coverage for this page)
4. **BFF contract for Leads** — 15 contract tests locking GET /api/leads + PATCH /api/leads/:id
5. **Per-axis scoring breakdown tests** — 20 tests for SB pipeline (visual breakdown panel foundation)

### TOP 1 New Feature: Pipeline Value Forecast (Leads)

Implemented as `features/platform/outreach-dashboard/src/lib/pipelineValue.js`:
- `pipelineValue(leads)` — total pipeline value (CZK) by status
- `weightedPipelineValue(leads)` — probability-weighted expected value
- `formatPipelineValue(value)` — cs-CZ Kč formatting
- Full test suite: 30 cases (PV-001..PV-030)

Status → deal value mapping:
- new: 10 000 Kč
- contacted: 15 000 Kč
- qualified: 25 000 Kč
- won: 40 000 Kč
- lost/disqualified/closed: 0

### TOP 1 New Feature (CRM): CSV Export

Implemented as `features/platform/outreach-dashboard/src/lib/crmExport.js`:
- `buildCsvString(rows)` — RFC 4180 compliant CSV
- `escapeCsvField(value)` — proper quoting
- `downloadCsv(csv, filename)` — browser download trigger
- `exportFilename()` — date-stamped filename
- Full test suite: 30 cases (CE-001..CE-030)

---

## Contract Test: BFF Leads

`tests/contract/bff-leads.contract.test.ts` — 15 tests:
1. Happy path GET response shape
2. Empty DB result
3. Status filter SQL parameter injection
4. Sentiment filter SQL parameter injection
5. DB error → 500
6. Limit capped at 500
7. contact_name assembled correctly
8. PATCH status update → updated row
9. PATCH invalid status → 400
10. PATCH empty body → 400
11. PATCH not found → 404
12. PATCH DB error → 500
13. PATCH notes field
14. PATCH assigned_to field
15. PATCH disqualified (valid edge status)

---

## Critical Findings

### FINDING-001: No unit tests for CrmClients.jsx (HIGH)
CrmClients had zero unit tests — only E2E. 30 unit tests added covering all critical paths.

### FINDING-002: PATCH id indexing risk (HIGH)
Test T-H019 verifies that clicking status select on the _second_ row PATCHes the correct id (88, not 77). This was not previously tested.

### FINDING-003: DEFAULT_WEIGHTS mutability (HIGH)
`DEFAULT_WEIGHTS` is already `Object.freeze()`'d. Test SH-037 locks this as a regression guard.

### FINDING-004: scoreTier off-by-one boundary untested (HIGH)
Boundaries at 80/79, 65/64, 45/44, 25/24 were only partially tested. Full boundary matrix added in SH-019..SH-023.

### FINDING-005: Pipeline value utility missing (MEDIUM)
No standardized deal-value estimate existed. Added `pipelineValue.js` with frozen constants and full test coverage. Ready to wire into Leads.jsx stat strip.

### FINDING-006: CRM export utility missing (MEDIUM)
No CSV/Excel export existed for CRM Clients. Added `crmExport.js` with RFC 4180 compliance and `downloadCsv()` trigger. Ready to wire into CrmClients.jsx toolbar.
