# Performance Baseline — Outreach Dashboard

**Status:** Baseline established
**Date:** 2026-04-30
**Trigger:** Establish CWV baseline + identify regressions before further perf work
**Scope:** `features/platform/outreach-dashboard` — routes `/`, `/replies`, `/campaigns`, `/companies`, `/mailboxes`
**Method:** Lighthouse 12.x via `chrome-launcher` (Chromium 1217), `--headless=new`, `--onlyCategories=performance`, default Lighthouse mobile preset (4× CPU throttle, Slow-4G simulated network), single run per route, served by `vite preview` against production build (no live BFF).
**Raw data:** [`features/platform/outreach-dashboard/reports/lighthouse/baseline-2026-04-30.json`](../../features/platform/outreach-dashboard/reports/lighthouse/baseline-2026-04-30.json)

## Budgets (per `~/.claude/rules/web/performance.md`)

| Metric | Budget |
|---|---|
| LCP | < 2500 ms |
| INP | < 200 ms |
| CLS | < 0.1 |
| JS bundle (gzipped, per route) | < 300 kB |

## Per-route results

| Route | Perf | LCP | INP (TBT proxy) | CLS | JS gz | LCP budget | CLS budget | JS budget |
|---|---:|---:|---:|---:|---:|:--:|:--:|:--:|
| `/`         | 88 | 3196 ms | 0 ms  | 0.010 | 237 kB | FAIL | PASS | PASS |
| `/replies`  | 81 | 4316 ms | 0 ms  | 0.000 | 241 kB | FAIL | PASS | PASS |
| `/campaigns`| 81 | 4321 ms | 0 ms  | 0.000 | 242 kB | FAIL | PASS | PASS |
| `/companies`| 80 | 4334 ms | 0 ms  | 0.000 | 262 kB | FAIL | PASS | PASS |
| `/mailboxes`| 79 | 4482 ms | 12 ms | 0.009 | 258 kB | FAIL | PASS | PASS |

INP cannot be measured from a cold Lighthouse run (no real interactions); TBT (Total Blocking Time) is used as the proxy. Across all routes TBT ≤ 12 ms, so the 200 ms INP budget is very likely safe in practice.

## Three worst offenders

### 1. LCP exceeds the 2.5 s budget on every measured route
All five routes fail the LCP budget under Lighthouse's default mobile throttling. The lightest is `/` at 3.20 s (28 % over budget); the heaviest is `/mailboxes` at 4.48 s (79 % over budget). FCP is in the 2.7–2.9 s band on every route, so the gap is not the network ramp — it is *what runs before paint*.

### 2. `vendor-sentry` chunk = 155 kB gzipped (~65 % of shared JS)
The shared JS baseline that every route ships is 237 kB gzipped. Of that, `vendor-sentry-DEIRWVxj.js` alone is **155 kB gzipped** (470 kB raw). React is 60 kB, Router 14 kB, app shell 13 kB. Sentry is the single largest perf lever and is loaded eagerly on every route. Options to consider (in a follow-up; not in scope here): defer init, lazy `import('@sentry/react')` after first paint, drop the Node SDK from the client bundle if it leaked in, or trim integrations.

### 3. `/companies` and `/mailboxes` route chunks are each ~22–25 kB gzipped
After the shared baseline, these two routes add the largest per-route chunks: `Companies-*.js` = 25 kB gz (88 kB raw, was 88 kB+ in the prior baseline too) and `Mailboxes-*.js` = 22 kB gz (73 kB raw). Both correlate with the worst per-route LCP (4.33 s and 4.48 s) and the highest script byte weight (280 kB / 278 kB uncompressed). Likely candidates: large icon imports, big in-route table/grid components, or unneeded eager imports.

## What looks healthy

- **CLS** is essentially 0 across all routes (worst is 0.010 on `/`). Layout stability is strong.
- **TBT** is ≤ 12 ms everywhere, suggesting INP risk is low under real interaction.
- **Per-route JS gzipped** is comfortably under the 300 kB budget on every route (max 262 kB on `/companies`).
- **CSS** is a single 14 kB gzipped file shared across all routes.

## Notes / setup gaps

- Lighthouse was run against `vite preview` (static prod bundle) on `127.0.0.1:5175`. No live Go backend or BFF was attached, so routes that fetch on mount may render lighter than they would under real backend latency. A second pass with the BFF + Go backend wired up would tighten the LCP numbers.
- INP is approximated by TBT; a proper INP baseline would require a Playwright-driven interaction trace. Out of scope for this baseline run.
- Single run per route — no median over 3–5 runs. Variance is therefore unmeasured.
- Baseline was captured on the developer's local machine, not on a CI runner. Future regressions must compare against a CI-pinned re-baseline to be apples-to-apples.

## Next steps (not executed in this audit)

1. Lazy-load Sentry after first paint, or split it into a deferred chunk.
2. Profile `/mailboxes` and `/companies` route bundles with `rollup-plugin-visualizer` to confirm what dominates the per-route chunk.
3. Re-run Lighthouse with BFF + Go backend attached for an end-to-end LCP number.
4. Wire a CI Lighthouse job (median-of-N) so this baseline becomes a ratchet.
