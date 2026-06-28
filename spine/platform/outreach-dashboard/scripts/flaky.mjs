#!/usr/bin/env node
// Flaky-test detector — re-run vitest N times, count pass/fail per test.
// Anything < N/N pass = flaky → reports/flaky/summary.json + BASELINE.md.
// Run: node scripts/flaky.mjs [runs=5]

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'

const RUNS = Number(process.argv[2] || 5)
const TMP = 'reports/flaky/.run.json'

mkdirSync('reports/flaky', { recursive: true })

const tally = new Map() // key=fullName → { pass, fail, file }

for (let i = 1; i <= RUNS; i++) {
  process.stderr.write(`flaky run ${i}/${RUNS} ... `)
  if (existsSync(TMP)) rmSync(TMP)
  const res = spawnSync('pnpm', [
    'exec', 'vitest', 'run',
    '--reporter=json', `--outputFile=${TMP}`,
    // skip suites that require side-effect infra not present in every run
    '--exclude=src/lighthouse.budget.test.js',
    '--exclude=src/bundle.budget.test.js',
  ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })

  if (!existsSync(TMP)) {
    process.stderr.write(`no json output (exit ${res.status})\n`)
    continue
  }
  const j = JSON.parse(readFileSync(TMP, 'utf8'))
  const files = j.testResults || []
  let p = 0, f = 0
  for (const tr of files) {
    for (const a of tr.assertionResults || []) {
      const key = `${tr.name} :: ${a.fullName || a.title}`
      const t = tally.get(key) || { pass: 0, fail: 0, file: tr.name }
      if (a.status === 'passed') { t.pass++; p++ }
      else if (a.status === 'failed') { t.fail++; f++ }
      tally.set(key, t)
    }
  }
  process.stderr.write(`pass=${p} fail=${f}\n`)
}

if (existsSync(TMP)) rmSync(TMP)

const flaky = []
const stable = { pass: 0, fail: 0 }
for (const [key, v] of tally) {
  const total = v.pass + v.fail
  if (total === RUNS && v.pass < RUNS) {
    flaky.push({ key, file: v.file, pass: v.pass, fail: v.fail, runs: RUNS })
  } else if (total < RUNS) {
    flaky.push({ key, file: v.file, pass: v.pass, fail: v.fail, runs: total, note: 'missing runs' })
  }
  stable.pass += v.pass
  stable.fail += v.fail
}
flaky.sort((a, b) => a.pass - b.pass)

const summary = { runs: RUNS, total_tests: tally.size, flaky_count: flaky.length, flaky, totals: stable }
writeFileSync('reports/flaky/summary.json', JSON.stringify(summary, null, 2))

const md = [
  '# Flaky Test Baseline',
  '',
  `- Runs: ${RUNS}`,
  `- Total unique tests: ${tally.size}`,
  `- Flaky (< ${RUNS}/${RUNS}): ${flaky.length}`,
  `- Aggregate: pass=${stable.pass} fail=${stable.fail}`,
  '',
  '## Flaky tests',
  '',
  flaky.length === 0
    ? '_None — all tests passed every run._'
    : flaky.map(t => `- \`${t.key}\` — ${t.pass}/${t.runs} pass`).join('\n'),
  '',
].join('\n')
writeFileSync('reports/flaky/BASELINE.md', md)
console.log(`flaky: ${flaky.length}/${tally.size} unstable across ${RUNS} runs → reports/flaky/`)
