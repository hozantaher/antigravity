// @linkage-allowed: discipline ratchet — scans files dynamically (not via static imports)
// Flaky-detector summary check — reads reports/flaky/summary.json produced
// by `node scripts/flaky.mjs N`. Skipped when summary missing (CI gates run
// the detector first, then vitest). Asserts: schema, run count >= 2, and
// flaky_count below a documented baseline. The baseline is *current* number
// of flakes — tighten only after fixing real infra issues (shared backend,
// data interference). NOT zero — the suite hits a single live Postgres so
// some intermittent failure is expected. See reports/flaky/BASELINE.md.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

const PATH = 'reports/flaky/summary.json'
const BASELINE_FLAKY_MAX = 250  // current 203 — budget catches a regression toward total chaos

// describe.skipIf still evaluates the callback at collection time to register
// test names, so the body must not throw when PATH is missing. Load lazily.
describe.skipIf(!existsSync(PATH))('Flaky test detector', () => {
  const sum = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : {}

  it('summary has expected schema', () => {
    expect(sum).toHaveProperty('runs')
    expect(sum).toHaveProperty('total_tests')
    expect(sum).toHaveProperty('flaky_count')
    expect(sum).toHaveProperty('flaky')
    expect(Array.isArray(sum.flaky)).toBe(true)
  })

  it('detector ran at least twice (single run cannot detect flake)', () => {
    expect(sum.runs).toBeGreaterThanOrEqual(2)
  })

  it(`flaky count <= ${BASELINE_FLAKY_MAX} (got ${sum.flaky_count})`, () => {
    expect(sum.flaky_count, `${sum.flaky_count} flakes — see reports/flaky/BASELINE.md`).toBeLessThanOrEqual(BASELINE_FLAKY_MAX)
  })

  it('aggregate pass rate > 80%', () => {
    const total = sum.totals.pass + sum.totals.fail
    const rate = total ? sum.totals.pass / total : 0
    expect(rate, `pass rate ${(rate * 100).toFixed(1)}%`).toBeGreaterThan(0.8)
  })
})
