// @linkage-allowed: discipline ratchet — scans files dynamically (not via static imports)
// KPI regression diff — CURRENT.json vs BASELINE.json. Tolerances are
// per-metric: bundle gzip allowed +10%, lighthouse perf allowed -5pts,
// test count must NOT shrink (loss = lost coverage), security must NOT
// rise. Update baseline on green main commit:
//   node scripts/kpi-snapshot.mjs --baseline
// Skipped if either file missing.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

const CUR  = 'reports/kpi/CURRENT.json'
const BASE = 'reports/kpi/BASELINE.json'

const TOL = {
  bundleJsPct:  10,   // +10% gzip allowed before regression
  bundleCssPct: 10,
  lhPerfDrop:   5,    // perf score may drop ≤5 pts
  flakyDelta:   20,   // flake count may rise ≤20 (one new flaky test = ~5 fail entries × runs)
}

// describe.skipIf still evaluates the callback at collection time to register
// test names, so the body must not throw when files are missing. Load lazily.
describe.skipIf(!existsSync(CUR) || !existsSync(BASE))('KPI regression diff', () => {
  const present = existsSync(CUR) && existsSync(BASE)
  const cur  = present ? JSON.parse(readFileSync(CUR, 'utf8'))  : {}
  const base = present ? JSON.parse(readFileSync(BASE, 'utf8')) : {}

  describe('tests', () => {
    it('total test count not shrinking', () => {
      if (cur.tests?.total == null || base.tests?.total == null) return
      expect(cur.tests.total, `lost tests: ${base.tests.total} → ${cur.tests.total}`)
        .toBeGreaterThanOrEqual(base.tests.total)
    })
    it(`flaky count rise ≤ ${TOL.flakyDelta}`, () => {
      if (cur.tests?.flaky == null || base.tests?.flaky == null) return
      expect(cur.tests.flaky - base.tests.flaky).toBeLessThanOrEqual(TOL.flakyDelta)
    })
  })

  describe('bundle', () => {
    it(`js gzip rise ≤ ${TOL.bundleJsPct}%`, () => {
      if (!cur.bundle || !base.bundle) return
      const pct = ((cur.bundle.jsGzip - base.bundle.jsGzip) / base.bundle.jsGzip) * 100
      expect(pct, `js gzip ${base.bundle.jsGzip} → ${cur.bundle.jsGzip} (+${pct.toFixed(1)}%)`)
        .toBeLessThanOrEqual(TOL.bundleJsPct)
    })
    it(`css gzip rise ≤ ${TOL.bundleCssPct}%`, () => {
      if (!cur.bundle || !base.bundle) return
      const pct = ((cur.bundle.cssGzip - base.bundle.cssGzip) / base.bundle.cssGzip) * 100
      expect(pct).toBeLessThanOrEqual(TOL.bundleCssPct)
    })
  })

  describe('lighthouse', () => {
    it(`avg perf drop ≤ ${TOL.lhPerfDrop} pts`, () => {
      if (cur.lighthouse?.avgPerf == null || base.lighthouse?.avgPerf == null) return
      const drop = base.lighthouse.avgPerf - cur.lighthouse.avgPerf
      expect(drop, `avg perf ${base.lighthouse.avgPerf} → ${cur.lighthouse.avgPerf} (-${drop} pts)`)
        .toBeLessThanOrEqual(TOL.lhPerfDrop)
    })
    it('per-route perf drop ≤ 10 pts each', () => {
      if (!cur.lighthouse?.perRoute || !base.lighthouse?.perRoute) return
      const regressions = []
      for (const [path, basePerf] of Object.entries(base.lighthouse.perRoute)) {
        const curPerf = cur.lighthouse.perRoute[path]
        if (curPerf != null && basePerf - curPerf > 10) {
          regressions.push(`${path}: ${basePerf}→${curPerf}`)
        }
      }
      expect(regressions, `perf regressions: ${regressions.join(', ')}`).toEqual([])
    })
  })

  describe('security', () => {
    it('critical CVEs not rising', () => {
      if (cur.security == null || base.security == null) return
      expect(cur.security.critical).toBeLessThanOrEqual(base.security.critical)
    })
    it('high CVEs rise ≤ 2 (allows transient unfixed advisories)', () => {
      if (cur.security == null || base.security == null) return
      expect(cur.security.high - base.security.high).toBeLessThanOrEqual(2)
    })
  })
})
