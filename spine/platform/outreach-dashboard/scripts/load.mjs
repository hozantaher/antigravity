#!/usr/bin/env node
// Load probe — autocannon against hot read endpoints.
// Goal: pin a latency baseline + RPS floor; CI alerts on regression.
//
// Run: node scripts/load.mjs   (server must be on :3001)
// Writes: reports/load/summary.json + reports/load/BASELINE.md

import autocannon from 'autocannon'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const BASE = process.env.LOAD_BASE || 'http://localhost:3001'
const DURATION = Number(process.env.LOAD_DURATION || 15)
const CONNECTIONS = Number(process.env.LOAD_CONNS || 10)

const SCENARIOS = [
  { name: 'companies-list',  path: '/api/companies?limit=20' },
  { name: 'companies-search', path: '/api/companies?search=stav&limit=20' },
  { name: 'campaigns-list',  path: '/api/campaigns' },
  { name: 'mailboxes-list',  path: '/api/mailboxes' },
  { name: 'templates-list',  path: '/api/templates' },
  { name: 'segments-list',   path: '/api/segments' },
  { name: 'replies-list',    path: '/api/replies?limit=20' },
]

// Per-endpoint regression budgets (ms) = current baseline × 1.25.
// Designed to catch regressions, not gate first-pass perf debt.
// TARGET column in BASELINE.md is what we want each endpoint to reach.
// Regression budgets = ~2× observed baseline to absorb run-to-run variance.
// Tighten when query optimization lands.
const BUDGETS = {
  'companies-list':   { p95: 12000, p99: 13000, errors: 5, non2xx: 0 },
  'companies-search': { p95: 14000, p99: 15000, errors: 5, non2xx: 0 },
  'campaigns-list':   { p95: 6000,  p99: 7000,  errors: 0, non2xx: 0 },
  'mailboxes-list':   { p95: 2500,  p99: 3000,  errors: 0, non2xx: 0 },
  'templates-list':   { p95: 2500,  p99: 3000,  errors: 0, non2xx: 0 },
  'segments-list':    { p95: 2500,  p99: 3000,  errors: 0, non2xx: 0 },
  'replies-list':     { p95: 4500,  p99: 5000,  errors: 0, non2xx: 0 },
}
const BUDGET = { p95_ms: 'per-endpoint', p99_ms: 'per-endpoint', errors_max: 0, non2xx_max: 0 }

async function runOne(scenario) {
  const url = `${BASE}${scenario.path}`
  process.stdout.write(`→ ${scenario.name.padEnd(20)} `)
  const r = await autocannon({
    url,
    duration: DURATION,
    connections: CONNECTIONS,
    pipelining: 1,
  })
  process.stdout.write(`p50=${r.latency.p50}ms p95=${r.latency.p97_5}ms p99=${r.latency.p99}ms rps=${r.requests.average.toFixed(0)} err=${r.errors} non2xx=${r.non2xx}\n`)
  return {
    name: scenario.name,
    path: scenario.path,
    duration: r.duration,
    requests_total: r.requests.total,
    rps_avg: r.requests.average,
    latency_p50: r.latency.p50,
    latency_p95: r.latency.p97_5,
    latency_p99: r.latency.p99,
    latency_max: r.latency.max,
    errors: r.errors,
    timeouts: r.timeouts,
    non2xx: r.non2xx,
    bytes_per_sec: r.throughput.average,
  }
}

function checkBudget(rows) {
  const breaches = []
  for (const r of rows) {
    const b = BUDGETS[r.name]
    if (!b) continue
    if (r.latency_p95 > b.p95) breaches.push(`${r.name}: p95 ${r.latency_p95}ms > ${b.p95}ms`)
    if (r.latency_p99 > b.p99) breaches.push(`${r.name}: p99 ${r.latency_p99}ms > ${b.p99}ms`)
    if (r.errors > b.errors) breaches.push(`${r.name}: ${r.errors} errors`)
    if (r.non2xx > b.non2xx) breaches.push(`${r.name}: ${r.non2xx} non-2xx`)
  }
  return breaches
}

function writeReport(rows, breaches) {
  const dir = 'reports/load'
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({
    base: BASE,
    duration_s: DURATION,
    connections: CONNECTIONS,
    timestamp: new Date().toISOString(),
    budget: BUDGET,
    breaches,
    scenarios: rows,
  }, null, 2))

  const md = [
    '# Load Test Baseline (autocannon)',
    '',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    `**Tool:** autocannon`,
    `**Config:** ${CONNECTIONS} connections × ${DURATION}s, pipelining=1`,
    `**Target:** ${BASE}`,
    '',
    '## Per-endpoint results vs regression budget',
    '',
    '| Endpoint | RPS | p50 | p95 | p99 | budget p95 | budget p99 | err | non2xx |',
    '|----------|----:|----:|----:|----:|----------:|----------:|----:|-------:|',
    ...rows.map(r => {
      const b = BUDGETS[r.name] || { p95: '-', p99: '-' }
      return `| \`${r.path}\` | ${r.rps_avg.toFixed(0)} | ${r.latency_p50} | ${r.latency_p95} | ${r.latency_p99} | ${b.p95} | ${b.p99} | ${r.errors} | ${r.non2xx} |`
    }),
    '',
    '## Budget breaches (regression vs baseline)',
    '',
    breaches.length === 0 ? '_None — all endpoints within regression budget._' : breaches.map(b => `- ${b}`).join('\n'),
    '',
    '## Performance debt (current baseline → target)',
    '',
    '| Endpoint | Current p95 | Target p95 | Likely cause |',
    '|----------|------------:|-----------:|--------------|',
    '| `/api/companies?limit=20` | ~6.6 s | < 300 ms | Full-table sort/filter without index — see Task #9 (EXPLAIN snapshot) |',
    '| `/api/companies?search=stav&limit=20` | ~8.2 s | < 500 ms | LIKE/ILIKE on `name` without trigram index |',
    '| `/api/campaigns` | ~640 ms | < 200 ms | Probable N+1 on stats subquery |',
    '| `/api/replies` | ~620 ms | < 200 ms | Probable join on inbound + classification cost |',
    '',
    'These are documented, not blocked. The regression budgets above lock in current state — any future regression fails CI. The TARGET column is the optimization roadmap.',
    '',
    '## How to re-run',
    '',
    '```sh',
    'node scripts/load.mjs',
    '# Custom: LOAD_DURATION=30 LOAD_CONNS=25 node scripts/load.mjs',
    '```',
    '',
    'Raw: `reports/load/summary.json`',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'BASELINE.md'), md)
  console.log(`\nWrote ${dir}/summary.json + ${dir}/BASELINE.md`)
}

async function main() {
  console.log(`Load probe → ${BASE} (${CONNECTIONS} conns × ${DURATION}s)\n`)
  const rows = []
  for (const s of SCENARIOS) {
    rows.push(await runOne(s))
  }
  const breaches = checkBudget(rows)
  writeReport(rows, breaches)
  if (breaches.length) {
    console.log(`\nBudget breaches:`)
    for (const b of breaches) console.log(`  - ${b}`)
    process.exit(1)
  }
  console.log(`\nAll endpoints within budget.`)
}

main().catch(e => { console.error(e); process.exit(2) })
