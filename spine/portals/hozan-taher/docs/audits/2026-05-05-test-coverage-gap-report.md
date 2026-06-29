# MVP Test Coverage Gap Report

**Status:** Draft
**Date:** 2026-05-05
**Trigger:** Pre-launch MVP readiness audit — identify untested critical paths before first campaign dispatch
**Author:** automated coverage audit agent

---

## 1. Per-Package Coverage Table

| Package | Coverage % | Test Count | Notes |
|---------|-----------|-----------|-------|
| `features/outreach/campaigns/sender` | 90.5% | 740+ | 2 audit ratchet tests fail (synthetic.go bypass) |
| `features/outreach/campaigns/campaign` | 60.4% (excl. panic) | 261 | 1 test panics (see Show Stoppers) |
| `features/outreach/campaigns/content` | 96.7% | 176 | |
| `features/inbound/orchestrator/imap` | 91.7% | 206 | |
| `features/inbound/orchestrator/thread` | 98.5% | 325 | |
| `features/inbound/orchestrator/intelligence` | 92.7% | 230 | |
| `features/platform/common/calendar` | >95% (est.) | 62 | IsExtendedDeadDay has 8 tests |
| `features/platform/common/humanize` | 97.3% | 346 | |
| `features/platform/common/envconfig` | 85.7% (full run) | 42 | MustHave + MustValidate at 0% |
| `features/outreach/relay/cmd/relay` | 58.1% | 141 | main() body at 29.7% |
| `features/outreach/relay/internal/delivery` | 95.4% | 264 | BuildMessage 100%, Deliver 80.4% |

**BFF (server-routes) — contract test status:**

| Route File | Contract Tests | Critical Gaps |
|-----------|---------------|--------------|
| `health.js` — `/api/morning-readiness` | `bff-morning-readiness.contract.test.ts` (11 cases) | **MISSING**: `/api/launch-readiness` endpoint (line 489) |
| `health.js` — `/api/launch-readiness` | NONE | Entire endpoint untested by contract suite |
| `dedupGuard.js` — `/api/dedup-guard/*` | NONE | All 3 routes uncontracted |
| `crm.js` — `/api/crm/clients/import` | NONE | XLSX import handler untested |
| `crm.js` — GET routes | E2E smoke only (`crm-clients.spec.ts`) | No contract-level mocked DB tests |
| `morningReadiness.js` | `bff-morning-readiness.contract.test.ts` | Good coverage |
| `operatorMetrics.js` | `bff-operator-metrics.contract.test.ts` | Good coverage |

---

## 2. Per-Critical-Path Verdict

### 2.1 `features/outreach/campaigns/sender` — Engine + enforceAirtightGate + CheckEligibility

**Verdict: PARTIAL (test infrastructure broken)**

- `CheckEligibility` (dedup_guard.go:83): **100% covered** — 15 direct tests in `dedup_guard_test.go` covering DNT, lifetime, cross-campaign cooldown, per-domain cooldown, error paths, context cancellation, and config variants.
- `Engine.Run()` (engine.go:197+): **covered** across `engine_test.go`, `run_test.go`, `run_coverage_test.go`, `engine_branches_test.go`.
- `enforceAirtightGate`: covered by `airtight_audit_test.go` (baseline ratchet).
- **BLOCKING BUG**: `TestRunCampaign_ConcurrentRunners_ExactlyOneAdvance_H1` in `campaign/runner_silent_exec_test.go:258` **panics** because `casFakeDB.QueryRowContext` returns `nil` for the `SELECT dnt, lifetime_touches, email_domain FROM contacts` query added by migration 049. The nil `*sql.Row` passed to `.Scan()` in `CheckEligibility` causes SIGSEGV. File: `features/outreach/campaigns/campaign/runner_silent_exec_test.go:396-419`.

### 2.2 `features/outreach/campaigns/sender/dedup_guard.go` — 8 Dedup Axes

**Verdict: PARTIAL — 4/8 axes implemented + tested; 4 axes defined in BFF only**

Axes 1-4 in `CheckEligibility` (Go): DNT, lifetime_touches, cross_campaign_cooldown, per_domain_cooldown — **all tested** (15 test cases).

Axes 5-8 defined in `dedupGuard.js:36-39` (BFF counts only, never enforced pre-send):
- `bounce_cluster` — no Go implementation
- `region_rate_limit` — no Go implementation
- `engagement_decay` — no Go implementation
- `crm_active_client` — referenced in `health.js:505` as "8th dedup-guard axis" but not in `CheckEligibility`

These 4 axes exist as skip_reason labels in the BFF stats panel but the Go enforcement path is absent.

### 2.3 `features/outreach/relay/cmd/relay` — Drain Loop, Sealed Envelope, BuildMessage

**Verdict: COVERED at function level, main() body thin**

- `runDrainLoop` (main.go:1009): 100%
- `processDrainEnvelope` (main.go:1103): 100%
- `runSealedSubscriberLoop` (main.go:971): 100%
- `handleSealedEnvelope` (main.go:844): 100%
- `BuildMessage` (delivery/smtp.go:251): **100%** — 15 tests across `smtp_test.go`, `smtp_extra_test.go`, `privacy_test.go`
- `main()` (main.go:57): **29.7%** — only the config-loading, helper-function branches are covered; full startup wiring untested. The 58.1% package total is brought down by `main()`.

### 2.4 `features/inbound/orchestrator/imap/poller.go` — Reply ingestion, seen LRU, auth fail

**Verdict: WELL COVERED**

- `NewPoller`: tested in `imap_test.go`
- Seen LRU: 6 dedicated tests in `poller_seen_lru_test.go`
- Auth failure (AUTHENTICATION FAILED): covered in `conn_test.go:213`, `coverage_gaps_test.go:462`, `coverage_test.go:171`
- 91.7% package coverage

### 2.5 `features/inbound/orchestrator/thread/inbound.go` — Reply classification + auto-DNT

**Verdict: WELL COVERED (98.5%)**

- `InboundProcessor.Process` paths: `thread_test.go`, `unit_test.go`, `s1_4_test.go`, `e2e_test.go`
- `ApplyAutoDNT`: 12 tests in `auto_dnt_test.go` covering all sentiment categories, idempotency, error paths
- Classifier disagreement: `inbound_classifier_disagreement_test.go`
- Bounce backpressure: 7 tests in `inbound_backpressure_test.go`

### 2.6 `features/inbound/orchestrator/intelligence` — Operator metrics + scoring

**Verdict: COVERED (92.7%)**

- `Collect`, `RunMetricsDaemon`, `MarshalSnapshot`, `Snapshot`: 11 tests in `operator_metrics_test.go`
- All exported functions covered

### 2.7 `features/platform/outreach-dashboard/src/server-routes/health.js` — `/api/launch-readiness`, `/api/morning-readiness`, `/api/dedup-guard/*`

**Verdict: PARTIAL — morning-readiness covered, launch-readiness and dedup-guard completely untested**

- `/api/morning-readiness`: `bff-morning-readiness.contract.test.ts` has 11 test cases. **Covered.**
- `/api/launch-readiness` (health.js:489): **ZERO contract tests**. The endpoint queries:
  - CRM coverage from `segment_memberships` JOIN `companies` (traffic light logic at lines 519-536)
  - Dedup guard migration column existence check (lines 546-572)
  - Mailbox status aggregate (lines 575+)
  - 400 validation on missing `campaign_id`/`segment_id` params
- `/api/dedup-guard/stats` (dedupGuard.js:27): **ZERO contract tests**
- `/api/dedup-guard/segment-funnel` (dedupGuard.js:116): **ZERO contract tests**
- `/api/dedup-guard/recent-skips` (dedupGuard.js:198): **ZERO contract tests**

### 2.8 `features/platform/outreach-dashboard/src/server-routes/crm.js` — XLSX import, client list

**Verdict: MISSING contract tests, E2E smoke only**

- `POST /api/crm/clients/import` (crm.js:212): **ZERO contract tests**. Import handler uses ExcelJS dynamic import, reads two worksheet formats (klienti vs OP), has dedup-on-conflict SQL. Edge cases not tested: empty XLSX, missing ICO column, malformed rows, partial failure mid-batch, audit log INSERT failure.
- `GET /api/crm/clients` (crm.js:28): No contract test. Only `crm-clients.spec.ts` E2E smoke which uses `page.route()` (which doesn't intercept `page.request.*` per memory `feedback_playwright_route_gotcha`).
- `GET /api/crm/clients/:id` (crm.js:139): Same — E2E mock only.
- `GET /api/crm/clients/stats` (crm.js:182): Same.

### 2.9 `scripts/audits/crm-import.mjs` — XLSX parsing edge cases

**Verdict: ZERO tests**

Functions `readSheet`, `clean`, `cleanEmail`, `cleanDate`, `mapKlient`, `mapOP` (lines 37-143) have no unit tests. These parse real XLSX input with no validation harness.

### 2.10 `features/platform/common/calendar/cz.go` — IsExtendedDeadDay

**Verdict: WELL COVERED**

8 tests in `cz_test.go:109-196` covering: weekends, state holidays, Vánoce window (Dec 22 – Jan 2), Jan 3 boundary, Dec 21 boundary, summer weekday, regular weekday, Easter Monday.

---

## 3. Show Stoppers for MVP (Top 5)

These paths MUST have tests before first campaign dispatch. Each has a corresponding GH issue.

### SS-1 — `campaigns/campaign.TestRunCampaign_ConcurrentRunners_ExactlyOneAdvance_H1` panics

**File:** `features/outreach/campaigns/campaign/runner_silent_exec_test.go:396-419`

The `casFakeDB.QueryRowContext` stub returns `nil` for queries it doesn't recognize. After migration 049 added the dedup guard `SELECT dnt, lifetime_touches, email_domain FROM contacts` query, `CheckEligibility` now calls `QueryRowContext` with a query that `casFakeDB` returns `nil` for, causing SIGSEGV in `database/sql.(*Row).Scan`. This crashes the entire campaign package test run. **New tests cannot be added to this package until the panic is fixed**, and the broken test blocks CI green.

Fix target: add a `SELECT dnt, lifetime_touches, email_domain` handler to `casFakeDB.QueryRowContext` that returns a stub eligible row.

### SS-2 — `/api/launch-readiness` has ZERO contract tests

**File:** `features/platform/outreach-dashboard/src/server-routes/health.js:489-610`

This endpoint is the pre-launch gate widget that operators use before dispatching a campaign. It checks CRM coverage %, dedup guard migration status, mailbox health, and sanity gates. It is freshly merged (PR #805 comment inline) and completely untested. Missing tests:
- 400 on invalid campaign_id/segment_id params
- CRM coverage traffic light thresholds (>10% amber, >25% red)
- Dedup guard migration column check (migrated=false path)
- Mailbox count aggregation
- Error recovery from individual section failures

### SS-3 — `/api/dedup-guard/*` — 3 routes with zero contract tests

**File:** `features/platform/outreach-dashboard/src/server-routes/dedupGuard.js:27,116,198`

These routes are the operational observability surface for the dedup guard. With the first campaign launch imminent, operators will rely on `/api/dedup-guard/stats` to confirm contacts are being skipped correctly and `/api/dedup-guard/segment-funnel` to see per-segment eligibility waterfall. Zero contract tests means regressions won't be caught. Missing: SQL error handling, empty-result shapes, pagination bounds on `recent-skips`.

### SS-4 — `POST /api/crm/clients/import` — XLSX import untested

**File:** `features/platform/outreach-dashboard/src/server-routes/crm.js:212-445`

The CRM XLSX import is the source of truth for which contacts are in the dedup guard's `crm_active_client` axis. If this endpoint silently fails on malformed input, the dedup guard's 8th axis is broken. Missing tests:
- Empty XLSX body → 400
- Missing required ICO column in sheet → error response
- Dedup-on-conflict behavior (UPDATE vs INSERT)
- Audit log entry confirmation
- Partial row failure isolation (one bad row should not abort good rows)

### SS-5 — Axes 5-8 of dedup guard not in Go `CheckEligibility`

**File:** `features/outreach/campaigns/sender/dedup_guard.go:83`

`bounce_cluster`, `region_rate_limit`, `engagement_decay`, and `crm_active_client` are tracked as BFF stats labels in `dedupGuard.js:36-39` and `health.js:505` calls `crm_client_id` the "8th dedup-guard axis" — but none of these are enforced in the Go pre-enqueue `CheckEligibility` function. The BFF dedup-guard stats panel will always show zeros for axes 5-8 because the Go engine never writes those skip_reasons. Missing tests: there can be no tests for unimplemented behavior, but this is a spec-vs-implementation gap that makes the dedup guard functionally incomplete at 4/8 axes.

---

## 4. Acceptable Debt

The following paths have adequate coverage relative to their risk profile and do not require new tests for MVP launch:

| Path | Coverage | Rationale |
|------|----------|-----------|
| `features/inbound/orchestrator/thread` (98.5%) | Excellent | InboundProcessor, auto-DNT, bounce all covered |
| `features/inbound/orchestrator/imap` (91.7%) | Good | Auth failure, seen-LRU, poll paths covered |
| `features/inbound/orchestrator/intelligence` (92.7%) | Good | Operator metrics and scoring loops covered |
| `features/outreach/campaigns/content` (96.7%) | Excellent | Template engine + humanize engine well tested |
| `features/outreach/campaigns/sender` (90.5%) | Good | Engine, dedup guard, antitrace, backoff all covered |
| `features/platform/common/calendar.IsExtendedDeadDay` | Full | 8 boundary tests covering all edge cases |
| `features/platform/common/humanize` (97.3%) | Excellent | All engine paths covered |
| `features/outreach/relay/internal/delivery` (95.4%) | Good | BuildMessage 100%, Deliver 80.4% |
| `features/outreach/relay` drain/sealed loops | 100% each | Critical relay functions fully covered |
| `features/platform/common/envconfig.MustHave` | 0% | Called only at boot → os.Exit; panics are acceptable; existing `Validate`/`Required` tests cover the logic |

**Known pre-existing test failures (not caused by this audit):**

1. `no_bypass_audit_test.go` — 2 tests fail because `features/inbound/orchestrator/probe/synthetic.go:159` constructs `NewAntiTraceClient` directly. Baseline ratchet needs update when that file is fixed.
2. `consumption_audit_test.go` — Fails because `orchestrator/probe/synthetic.go` uses raw `os.Getenv`. Same file, unrelated to coverage gaps.
3. `TestRunCampaign_ConcurrentRunners_ExactlyOneAdvance_H1` — Described in SS-1.
