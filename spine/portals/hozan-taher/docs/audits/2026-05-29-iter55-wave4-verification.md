# iter55 Wave 4 Verification — Stories 16-20 Live Run

**Status:** Completed  
**Date:** 2026-05-29  
**Branch tested:** `test/iter54-brutal-playwright-wave4` (SHA `3647e34e`)  
**BFF SHA confirmed:** `3647e34e8b4db30ba6d1e0ed46c5a07fb044a336` via `/api/health`  
**Playwright config:** custom (`/tmp/pw-iter54.config.js`) isolating only `iter54-story-*.spec.ts` to bypass pre-existing syntax error in `thread-detail-bottom-dock.smoke.spec.ts` (duplicate `classify` variable declaration at line 81 — that spec is on `main`, unrelated to wave 4).

---

## Blocker discovered during setup

`thread-detail-bottom-dock.smoke.spec.ts` has a duplicate `const classify` declaration (lines 70 and 81). This causes Playwright to abort all test collection when using the standard config. Isolated via custom config; the pre-existing bug must be fixed separately on `main`.

---

## Per-Story Results

| Story | Spec file | Pass | Fail | Skip | Real bugs |
|-------|-----------|------|------|------|-----------|
| 16 — Pagination boundaries | `iter54-story-16-pagination-boundaries.spec.ts` | 0 | 8 | 0 | 0 (infra) |
| 17 — Date range picker | `iter54-story-17-date-range-picker.spec.ts` | 3 | 1 | 0 | 1 |
| 18 — Toast stack | `iter54-story-18-toast-stack.spec.ts` | 4 | 1 | 0 | 0 (infra) |
| 19 — Network throttling | `iter54-story-19-network-throttle-resilience.spec.ts` | 1 | 3 | 0 | 0 (infra) |
| 20 — localStorage corruption | `iter54-story-20-localstorage-corruption.spec.ts` | 2 | 3 | 0 | 2 |

**Total: 10 passed / 16 failed / 0 skipped across 26 tests. Real bugs surfaced: 3.**

---

## Story 16 — Pagination boundaries (0/8 pass)

All 8 tests fail with `TimeoutError: page.waitForSelector: Timeout 8000ms exceeded` on `h1, h2`.

**Root cause: test infrastructure.** The `/replies`, `/vehicles`, and `/crm/clients` pages use `span` and breadcrumb elements, not `h1`/`h2` headings. The spec's page-load gate (`waitForSelector('h1, h2')`) never resolves. The actual pagination components (`data-testid="replies-pagination"`) likely exist, but the test never reaches that assertion.

**Real bugs found: 0.** The pagination features themselves are untested — the spec needs its load-gate selector fixed to `[data-testid="replies-table"]` or equivalent before it can give signal on the actual pagination behavior.

---

## Story 17 — Date range picker (3/4 pass)

**T17-A FAIL — Real bug:**  
When the operator sets `from > to` (inverted date range), no validation error is shown AND the Analytics timeline API fires with `from=2026-05-29&to=2026-05-01` (confirmed by request intercept). Both conditions expose a real issue: `Layout.jsx` / Analytics page has no input validation guard on date range inversion. An operator can accidentally query a nonsensical window with silent results.

**Assertion that broke:** `expect(errorVisible || !hasInvertedCall).toBe(true)` → received `false` (no error shown AND inverted API call fired).

**T17-B/C/D pass:** range > 365d, UTC/CET display, preset buttons all behave correctly.

---

## Story 18 — Toast stack (4/5 pass)

**T18-C FAIL — Test infrastructure issue:**  
The test injects toasts via `window.__toast` which is not exposed by the production app. When injection fails, `countAfterFire = 0`, and the assertion `expect(0).toBeLessThan(0)` always fails. The `return` early-exit branch at line 215 (`await expect(page.locator('h1, h2').first()).toBeVisible()`) itself fails because — again — the home page `/` does not render an `h1`/`h2` either.

The Toast auto-dismiss logic in `Toast.jsx` (RAF-based `onDismiss` when `total >= duration`) is architecturally sound but cannot be verified without exposing a `window.__toast` test hook or using a page action that triggers real toasts.

**Real bugs found: 0.**

---

## Story 19 — Network throttling (1/4 pass)

**T19-A FAIL — Test infrastructure issue:**  
The spec searches for generic selectors: `[class*="skeleton"]`, `[aria-busy="true"]`, etc. The actual app uses `data-testid="replies-table-skeleton"` (in `RepliesTableSkeleton.jsx`). The skeleton DOES exist; the spec just uses wrong selectors.

**T19-B FAIL — Test infrastructure issue:**  
Hard gate `await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 5_000 })` — same h1/h2 problem. The "still loading" soft assertion also uses generic text selectors (`text=/načítám/i`) not matching the actual skeleton component.

**T19-C FAIL — Test infrastructure issue:**  
`page.route('**/api/**', route => route.fulfill({ json: [] }))` should stub all API, but background polling crons (notifications, health checks, auth-fail-alerts) fire within the 500ms dedup window, registering as "duplicates." The 11 "duplicate" requests are background interval fires, not React StrictMode double-mounts. The dedup window is too wide for a page with background pollers. Additionally, the hard gate `expect(page.locator('h1, h2').first()).toBeVisible()` fails.

**T19-D PASS:** Navigate-away during in-flight request works correctly.

**Real bugs found: 0.**

---

## Story 20 — localStorage corruption (2/5 pass)

**T20-A PASS:** App boots after all keys corrupted — no crash.  
**T20-D PASS:** Corrupted nav collapse state resolves to valid boolean.

**T20-B FAIL — Real bug:**  
`localStorage.theme = 'banana'` → `data-theme="banana"` is set on `<html>`. No validation in `Layout.jsx` line 106: `localStorage.getItem('theme') || 'light'` — any arbitrary string is accepted and applied. The test confirmed `data-theme="banana"` was found in the DOM (`Expected: false, Received: true`).

**T20-E FAIL — Same real bug (same root cause as T20-B):**  
After a reload, `localStorage.theme` is still `"banana"` — the app reads, applies, and re-persists the corrupt value without sanitizing it.

**T20-C FAIL — Test infrastructure issue:**  
Hard gate `page.locator('h1, h2').first()` fails on `/crm/clients` (same h1/h2 infra issue). The underlying company-filter corruption behavior itself is untested.

**Real bugs found: 2** (T20-B + T20-E share one root cause: missing theme value validation in `Layout.jsx`).

---

## Summary of Real Bugs

| ID | Location | Severity | Description |
|----|----------|----------|-------------|
| BUG-17A | `Analytics.jsx` + date range UI | HIGH | No validation for inverted date range (from > to); API fires with nonsensical window, no error shown to operator |
| BUG-20B/E | `Layout.jsx:106` | MEDIUM | `localStorage.theme` value is unsanitized; arbitrary string (e.g. `"banana"`) is written to `data-theme` and re-persisted on reload |

---

## Infrastructure issues to fix before re-run

| Spec | Issue | Fix needed |
|------|-------|-----------|
| S16, S18, S19-B/C, S20-C | `waitForSelector('h1, h2')` — pages use spans/breadcrumbs | Replace with `[data-testid="replies-table"]`, `[data-testid="analytics-kpi-tab"]`, etc. |
| S18-C | `window.__toast` not exposed | Add `window.__toast = toast` in `ToastProvider` under `import.meta.env.DEV` or test environment |
| S19-A | Wrong skeleton selectors | Use `[data-testid="replies-table-skeleton"]` |
| S19-C | Dedup window too wide for background pollers | Stub ALL background routes before counting, or filter to replies-specific requests only |
| Pre-existing | `thread-detail-bottom-dock.smoke.spec.ts` — duplicate `classify` declaration | Remove redundant `const classify` at line 81 |

---

## Verification methodology

- BFF confirmed running at SHA `3647e34e` via `curl http://localhost:18001/api/health`
- Vite running at `http://localhost:18175` (pre-existing, confirmed `200 OK`)
- Each spec run individually via `node_modules/.bin/playwright test --config=/tmp/pw-iter54.config.js "iter54-story-N" --reporter=list`
- No spec files modified — failures are honest
- Stdout captured to `/tmp/s{16..20}.txt` per story
