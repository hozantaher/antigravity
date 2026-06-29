#!/usr/bin/env node
// KPI snapshot — fixed-format aggregation of test/bundle/perf/security probes.
// Writes reports/kpi/CURRENT.json. Use --baseline to *replace* BASELINE.json
// (e.g. on green main commit). Test src/kpi.diff.test.js compares CURRENT
// vs BASELINE and asserts no regression beyond per-metric tolerance.
//
// Run: node scripts/kpi-snapshot.mjs [--baseline]

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

mkdirSync('reports/kpi', { recursive: true })

function read(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
function gitSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().slice(0, 12) : null
}

const bundle    = read('reports/bundle/summary.json')
const lighthouse = read('reports/lighthouse/summary.json')
const flaky     = read('reports/flaky/summary.json')
const security  = read('reports/security/audit.json')
const licenses  = read('reports/security/licenses.json')

const lhAvg = lighthouse?.routes?.length
  ? Math.round(lighthouse.routes.reduce((s, r) => s + (r.perf || 0), 0) / lighthouse.routes.length)
  : null

const snapshot = {
  capturedAt: new Date().toISOString(),
  commit: gitSha(),
  tests: {
    total: flaky?.total_tests ?? null,
    flaky: flaky?.flaky_count ?? null,
    flakyRuns: flaky?.runs ?? null,
  },
  bundle: bundle ? {
    jsGzip: bundle.totals.js,
    cssGzip: bundle.totals.css,
    chunks: bundle.chunks?.length ?? 0,
  } : null,
  lighthouse: lighthouse ? {
    avgPerf: lhAvg,
    perRoute: Object.fromEntries((lighthouse.routes || []).map(r => [r.path, r.perf])),
  } : null,
  security: security ? {
    critical: security.metadata?.vulnerabilities?.critical ?? 0,
    high: security.metadata?.vulnerabilities?.high ?? 0,
    moderate: security.metadata?.vulnerabilities?.moderate ?? 0,
  } : null,
  licenses: licenses ? { total: licenses.total, distinct: Object.keys(licenses.byLicense || {}).length } : null,
}

writeFileSync('reports/kpi/CURRENT.json', JSON.stringify(snapshot, null, 2))
console.log('kpi snapshot →', 'reports/kpi/CURRENT.json')
console.log(JSON.stringify(snapshot, null, 2))

if (process.argv.includes('--baseline')) {
  copyFileSync('reports/kpi/CURRENT.json', 'reports/kpi/BASELINE.json')
  console.log('baseline updated → reports/kpi/BASELINE.json')
} else if (!existsSync('reports/kpi/BASELINE.json')) {
  copyFileSync('reports/kpi/CURRENT.json', 'reports/kpi/BASELINE.json')
  console.log('no baseline existed; seeded → reports/kpi/BASELINE.json')
}
