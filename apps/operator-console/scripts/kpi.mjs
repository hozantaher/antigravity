#!/usr/bin/env node
// KPI dashboard — single-page summary of every quality signal we measure.
// Aggregates: vitest count, mutation score, load latencies, EXPLAIN flags,
// a11y violations, security probe pass rate.
//
// Run: node scripts/kpi.mjs
// Writes: reports/KPI.md (human) + reports/kpi.json (machine)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'

function tryRead(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function tryJson(path) {
  const t = tryRead(path)
  if (!t) return null
  try { return JSON.parse(t) } catch { return null }
}

function vitestCount() {
  // Run vitest, accept non-zero exit (failing tests are still a real result).
  let out = ''
  try {
    out = execSync('pnpm vitest run --reporter=basic 2>&1', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    out = e.stdout || e.output?.filter(Boolean).join('') || ''
  }
  // RTK basic reporter (proxy): "PASS (N) FAIL (M)"
  let m = out.match(/PASS\s*\((\d+)\)\s*FAIL\s*\((\d+)\)/)
  if (m) {
    const passed = Number(m[1]), failed = Number(m[2])
    return { passed, failed, total: passed + failed }
  }
  // Standard vitest format: "Tests  N passed | M failed (T)" or "Tests  N passed (T)"
  m = out.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/)
  if (m) {
    const failed = Number(m[1] || 0), passed = Number(m[2])
    return { passed, failed, total: passed + failed }
  }
  return { passed: 0, failed: 0, total: 0, error: 'no match' }
}

function mutationScore() {
  const j = tryJson('reports/mutation/mutation.json')
  if (!j) {
    // Fall back to BASELINE.md if HTML/JSON not present.
    const md = tryRead('reports/mutation/BASELINE.md')
    if (md) {
      const m = md.match(/(\d+\.\d+)\s*%/g)
      if (m) return { score: parseFloat(m[m.length - 1]), source: 'BASELINE.md' }
    }
    return null
  }
  // Stryker JSON: { files: { ... }, ... } — use its summary if exposed.
  return { score: j?.systemUnderTestMetrics?.metrics?.mutationScore ?? null, source: 'mutation.json' }
}

function loadLatency() {
  const j = tryJson('reports/load/summary.json')
  if (!j) return null
  return {
    breaches: j.breaches?.length ?? 0,
    scenarios: (j.scenarios || []).map(s => ({
      name: s.name,
      p95: s.latency_p95,
      p99: s.latency_p99,
      rps: Math.round(s.rps_avg),
      err: s.errors,
    })),
  }
}

function explainSummary() {
  const j = tryJson('reports/explain/plans.json')
  if (!j) return null
  const flagged = (j.results || []).filter(r => r.flags && r.flags.length > 0)
  return {
    queries: j.results.length,
    healthy: j.results.filter(r => r.flags?.length === 0 && !r.error).length,
    flagged: flagged.length,
    flag_breakdown: flagged.map(r => ({ name: r.name, flags: r.flags, exec_ms: r.execution_ms })),
  }
}

function a11ySummary() {
  const j = tryJson('reports/a11y/summary.json')
  if (!j) return null
  const routes = Array.isArray(j) ? j : (j.routes || [])
  const totals = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  for (const route of routes) {
    for (const k of Object.keys(totals)) totals[k] += route[k] || route.byImpact?.[k] || 0
  }
  return { routes: routes.length, totals }
}

function bundleSummary() {
  const j = tryJson('reports/bundle/summary.json')
  if (!j) return null
  return { jsGzip: j.totals.js, cssGzip: j.totals.css, chunks: j.chunks?.length ?? 0 }
}

function lighthouseSummary() {
  const j = tryJson('reports/lighthouse/summary.json')
  if (!j?.routes?.length) return null
  const perfs = j.routes.map(r => r.perf || 0)
  return {
    avg: Math.round(perfs.reduce((s, x) => s + x, 0) / perfs.length),
    min: Math.min(...perfs),
    routes: j.routes.length,
  }
}

function flakySummary() {
  const j = tryJson('reports/flaky/summary.json')
  if (!j) return null
  const rate = j.total_tests ? (j.flaky_count / j.total_tests) * 100 : 0
  return { runs: j.runs, total: j.total_tests, flaky: j.flaky_count, ratePct: rate }
}

function securitySummary() {
  const audit = tryJson('reports/security/audit.json')
  const lic = tryJson('reports/security/licenses.json')
  if (!audit && !lic) return null
  const v = audit?.metadata?.vulnerabilities || {}
  return {
    critical: v.critical ?? 0,
    high: v.high ?? 0,
    moderate: v.moderate ?? 0,
    licenses: lic ? { total: lic.total, distinct: Object.keys(lic.byLicense || {}).length } : null,
  }
}

function replaySummary() {
  const j = tryJson('reports/replay/baseline.json')
  if (!j) return null
  return { paths: j.paths }
}

function fmt(v, d = '—') { return v == null ? d : v }

function gradeMutation(score) {
  if (score == null) return '?'
  if (score >= 85) return 'A'
  if (score >= 75) return 'B'
  if (score >= 65) return 'C'
  if (score >= 50) return 'D'
  return 'F'
}

function gradeTests(t) {
  if (!t || t.error) return '?'
  if (t.failed > 0) return 'F'
  if (t.total >= 1000) return 'A+'
  if (t.total >= 500) return 'A'
  if (t.total >= 200) return 'B'
  return 'C'
}

function gradeLoad(l) {
  if (!l) return '?'
  return l.breaches === 0 ? 'A' : l.breaches < 3 ? 'C' : 'F'
}

function gradeExplain(e) {
  if (!e) return '?'
  const ratio = e.healthy / Math.max(e.queries, 1)
  if (ratio === 1) return 'A'
  if (ratio >= 0.7) return 'B'
  if (ratio >= 0.4) return 'C'
  return 'F'
}

function gradeA11y(a) {
  if (!a) return '?'
  if (a.totals.critical === 0 && a.totals.serious === 0) return 'A'
  if (a.totals.critical === 0) return 'B'
  return 'C'
}

function gradeBundle(b) {
  if (!b) return '?'
  // Budget: 160k js / 12k css
  if (b.jsGzip <= 130_000 && b.cssGzip <= 10_000) return 'A'
  if (b.jsGzip <= 160_000 && b.cssGzip <= 12_000) return 'B'
  return 'C'
}

function gradeLighthouse(l) {
  if (!l) return '?'
  if (l.avg >= 85) return 'A'
  if (l.avg >= 70) return 'B'
  if (l.avg >= 60) return 'C'
  return 'F'
}

function gradeFlaky(f) {
  if (!f) return '?'
  if (f.ratePct < 5) return 'A'
  if (f.ratePct < 15) return 'B'
  if (f.ratePct < 25) return 'C'
  return 'F'
}

function gradeSecurity(s) {
  if (!s) return '?'
  if (s.critical > 0) return 'F'
  if (s.high > 3) return 'C'
  if (s.high > 0) return 'B'
  return 'A'
}

function main() {
  console.log('Aggregating KPIs…')
  const tests = vitestCount()
  const mutation = mutationScore()
  const load = loadLatency()
  const explain = explainSummary()
  const a11y = a11ySummary()
  const bundle = bundleSummary()
  const lighthouse = lighthouseSummary()
  const flaky = flakySummary()
  const security = securitySummary()
  const replay = replaySummary()

  const data = {
    timestamp: new Date().toISOString(),
    tests, mutation, load, explain, a11y, bundle, lighthouse, flaky, security, replay,
    grades: {
      tests: gradeTests(tests),
      mutation: gradeMutation(mutation?.score),
      load: gradeLoad(load),
      explain: gradeExplain(explain),
      a11y: gradeA11y(a11y),
      bundle: gradeBundle(bundle),
      lighthouse: gradeLighthouse(lighthouse),
      flaky: gradeFlaky(flaky),
      security: gradeSecurity(security),
    },
  }
  mkdirSync('reports', { recursive: true })
  writeFileSync('reports/kpi.json', JSON.stringify(data, null, 2))

  const md = [
    '# Quality KPI Dashboard',
    '',
    `**Generated:** ${data.timestamp}`,
    '',
    '## Grades at a glance',
    '',
    '| Signal | Grade | Headline |',
    '|--------|:-----:|----------|',
    `| Tests | **${data.grades.tests}** | ${fmt(tests?.total)} total · ${fmt(tests?.failed)} failing |`,
    `| Mutation | **${data.grades.mutation}** | ${fmt(mutation?.score?.toFixed(2))}% killed |`,
    `| Load p95 | **${data.grades.load}** | ${fmt(load?.breaches)} budget breaches |`,
    `| SQL plans | **${data.grades.explain}** | ${fmt(explain?.healthy)}/${fmt(explain?.queries)} clean |`,
    `| a11y | **${data.grades.a11y}** | ${fmt(a11y?.totals?.critical)} critical · ${fmt(a11y?.totals?.serious)} serious |`,
    `| Bundle | **${data.grades.bundle}** | ${fmt(bundle && (bundle.jsGzip/1024).toFixed(0))}k js · ${fmt(bundle && (bundle.cssGzip/1024).toFixed(0))}k css (gzip) |`,
    `| Lighthouse | **${data.grades.lighthouse}** | avg perf ${fmt(lighthouse?.avg)} · min ${fmt(lighthouse?.min)} (${fmt(lighthouse?.routes)} routes) |`,
    `| Flake rate | **${data.grades.flaky}** | ${fmt(flaky?.flaky)}/${fmt(flaky?.total)} = ${fmt(flaky?.ratePct?.toFixed(1))}% across ${fmt(flaky?.runs)} runs |`,
    `| Security | **${data.grades.security}** | ${fmt(security?.critical)} crit · ${fmt(security?.high)} high · ${fmt(security?.moderate)} mod · ${fmt(security?.licenses?.distinct)} licenses |`,
    `| Replay | — | ${fmt(replay?.paths)} paths captured |`,
    '',
    '## Detail',
    '',
    '### Tests',
    `- Passed: \`${fmt(tests?.passed)}\``,
    `- Failed: \`${fmt(tests?.failed)}\``,
    `- Total:  \`${fmt(tests?.total)}\``,
    tests?.error ? `- Error: ${tests.error}` : '',
    '',
    '### Mutation',
    mutation
      ? `- Score: **${fmt(mutation.score?.toFixed(2))}%** (source: \`${mutation.source}\`)`
      : '- _No mutation report found — run `pnpm test:mutation`_',
    '',
    '### Load (autocannon)',
    load
      ? [
          `- Budget breaches: **${load.breaches}**`,
          '',
          '| Scenario | p95 | p99 | RPS | err |',
          '|----------|----:|----:|----:|----:|',
          ...load.scenarios.map(s => `| ${s.name} | ${s.p95} | ${s.p99} | ${s.rps} | ${s.err} |`),
        ].join('\n')
      : '- _No load report — run `pnpm test:load`_',
    '',
    '### SQL EXPLAIN',
    explain
      ? [
          `- Queries probed: ${explain.queries}`,
          `- Healthy plans: ${explain.healthy}`,
          `- Flagged plans: ${explain.flagged}`,
          '',
          ...(explain.flag_breakdown.length
            ? ['| Query | Exec (ms) | Flags |', '|-------|----------:|-------|',
               ...explain.flag_breakdown.map(r => `| \`${r.name}\` | ${r.exec_ms?.toFixed(1)} | ${r.flags.join(', ')} |`)]
            : ['_All plans clean._']),
        ].join('\n')
      : '- _No EXPLAIN report — run `pnpm tools:explain`_',
    '',
    '### Accessibility',
    a11y
      ? `- Routes scanned: ${a11y.routes}\n- Critical: ${a11y.totals.critical} · Serious: ${a11y.totals.serious} · Moderate: ${a11y.totals.moderate} · Minor: ${a11y.totals.minor}`
      : '- _No a11y report — run `pnpm e2e -- --grep @a11y`_',
    '',
    '### Bundle',
    bundle
      ? `- JS gzip: **${(bundle.jsGzip/1024).toFixed(1)}k** · CSS gzip: **${(bundle.cssGzip/1024).toFixed(1)}k** · chunks: ${bundle.chunks}`
      : '- _No bundle report — run `pnpm build && node scripts/bundle.mjs`_',
    '',
    '### Lighthouse',
    lighthouse
      ? `- Avg perf: **${lighthouse.avg}** · min: **${lighthouse.min}** · routes: ${lighthouse.routes}`
      : '- _No lighthouse report — run `pnpm preview` then `node scripts/lighthouse.mjs`_',
    '',
    '### Flaky tests',
    flaky
      ? `- Flake rate: **${flaky.ratePct.toFixed(2)}%** (${flaky.flaky}/${flaky.total} across ${flaky.runs} runs)`
      : '- _No flaky report — run `node scripts/flaky.mjs 5`_',
    '',
    '### Security',
    security
      ? `- Vulns: ${security.critical} critical / ${security.high} high / ${security.moderate} moderate · ${security.licenses?.distinct ?? '?'} distinct licenses`
      : '- _No security report — run `node scripts/security.mjs`_',
    '',
    '### Shadow replay',
    replay
      ? `- Captured paths: **${replay.paths}** (re-run via vitest src/replay.diff.test.js)`
      : '- _No replay baseline — run `node scripts/shadow-capture.mjs`_',
    '',
    '## Per-tier baselines',
    '',
    '- Mutation: [reports/mutation/BASELINE.md](mutation/BASELINE.md)',
    '- Load: [reports/load/BASELINE.md](load/BASELINE.md)',
    '- EXPLAIN: [reports/explain/BASELINE.md](explain/BASELINE.md)',
    '- a11y: [reports/a11y/BASELINE.md](a11y/BASELINE.md)',
    '- Flaky: [reports/flaky/BASELINE.md](flaky/BASELINE.md)',
    '- KPI snapshot: [reports/kpi/BASELINE.json](kpi/BASELINE.json)',
    '',
  ].filter(Boolean).join('\n')
  writeFileSync('reports/KPI.md', md)
  console.log('Wrote reports/KPI.md + reports/kpi.json')
  console.log('\nGrades: ' + Object.entries(data.grades).map(([k, v]) => `${k}=${v}`).join('  '))
}

main()
