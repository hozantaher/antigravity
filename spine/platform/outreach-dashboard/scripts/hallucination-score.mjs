#!/usr/bin/env node
// A6 — Hallucination Score aggregator.
//
// Reads the JSON outputs of:
//   • assertion-audit.json         (A3: low-density + tautology)
//   • linkage-map.json             (A4: orphans)
//   • fixture-drift.json           (A1: drift entries when target reachable)
//   • inverted-fault-report.json   (A2: no-signal classifications)
//   • flaky_quarantine.json        (existing: flaky tests)
//   • mutation report (Stryker)    (existing: kill rate)
//
// Outputs a single 0-100 score. The Observability page reads this
// via /api/health/test-quality (added in next sprint).
//
// Score weights (sum to 100):
//   • Mutation kill rate         × 0.30
//   • Linkage (1 - orphan%)      × 0.20
//   • Assertion density          × 0.20
//   • Fixture drift (drift-free) × 0.10
//   • No-signal absence          × 0.10
//   • Flaky quarantine inverse   × 0.10

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

export function readJson(file) {
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch { return null }
}

export function scoreLinkage(linkage) {
  if (!linkage?.summary) return { value: null, weight: 0.20, contribution: 0 }
  const { orphan_pct } = linkage.summary
  const v = Math.max(0, 100 - orphan_pct * 2) // 5% orphans → 90; 50% → 0
  return { value: round(v), weight: 0.20, contribution: round(v * 0.20) }
}

export function scoreAssertionDensity(audit) {
  if (!audit?.summary) return { value: null, weight: 0.20, contribution: 0 }
  const { low_density_pct, tautology_blocks, test_blocks } = audit.summary
  const dense = Math.max(0, 100 - low_density_pct)
  const tautPct = test_blocks === 0 ? 0 : (tautology_blocks / test_blocks) * 100
  const tautPenalty = Math.min(20, tautPct * 5)
  const v = Math.max(0, dense - tautPenalty)
  return { value: round(v), weight: 0.20, contribution: round(v * 0.20) }
}

export function scoreFixtureDrift(drift) {
  if (!drift?.summary) return { value: null, weight: 0.10, contribution: 0 }
  const { reachable, endpoints } = drift.summary
  if (endpoints === 0) return { value: 100, weight: 0.10, contribution: 10 }
  const reachablePct = (reachable / endpoints) * 100
  return { value: round(reachablePct), weight: 0.10, contribution: round(reachablePct * 0.10) }
}

export function scoreNoSignal(report) {
  if (!report?.findings) return { value: 100, weight: 0.10, contribution: 10 }
  const total = report.findings.length || 1
  const noSignal = report.findings.filter(f => f.kind === 'no-signal').length
  const v = Math.max(0, 100 - (noSignal / total) * 100)
  return { value: round(v), weight: 0.10, contribution: round(v * 0.10) }
}

export function scoreMutation(report) {
  if (!report?.mutationScore && !report?.killRate) return { value: null, weight: 0.30, contribution: 0 }
  const v = report.mutationScore || report.killRate
  return { value: round(v), weight: 0.30, contribution: round(v * 0.30) }
}

export function scoreFlaky(report) {
  if (!report) return { value: 100, weight: 0.10, contribution: 10 }
  const quarantined = (report.quarantined || []).length
  const total = report.total || 100
  const v = Math.max(0, 100 - (quarantined / total) * 200) // 0.5% quarantined → 0
  return { value: round(v), weight: 0.10, contribution: round(v * 0.10) }
}

function round(n) { return Math.round(n * 10) / 10 }

export function computeScore(inputs) {
  const components = {
    mutation: scoreMutation(inputs.mutation),
    linkage: scoreLinkage(inputs.linkage),
    assertion: scoreAssertionDensity(inputs.assertion),
    fixtureDrift: scoreFixtureDrift(inputs.fixtureDrift),
    noSignal: scoreNoSignal(inputs.noSignal),
    flaky: scoreFlaky(inputs.flaky),
  }
  // Re-normalize: if some components have null values, redistribute their weight
  let totalAvailableWeight = 0
  for (const c of Object.values(components)) {
    if (c.value !== null) totalAvailableWeight += c.weight
  }
  let total = 0
  if (totalAvailableWeight === 0) return { score: 0, components, severity: 'unknown' }
  for (const c of Object.values(components)) {
    if (c.value !== null) {
      const adjusted = c.weight / totalAvailableWeight
      total += c.value * adjusted
    }
  }
  return {
    score: round(total),
    components,
    severity: severityOf(total),
  }
}

export function severityOf(score) {
  if (score >= 85) return 'green'
  if (score >= 70) return 'yellow'
  if (score >= 50) return 'orange'
  return 'red'
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const inputs = {
    mutation: readJson(join(ROOT, 'reports/mutation/mutation.json')),
    linkage: readJson(join(ROOT, 'linkage-map.json')),
    assertion: readJson(join(ROOT, 'assertion-audit.json')),
    fixtureDrift: readJson(join(ROOT, 'fixture-drift.json')),
    noSignal: readJson(join(ROOT, 'inverted-fault-report.json')),
    flaky: readJson(join(ROOT, 'flaky_quarantine.json')),
  }

  const result = computeScore(inputs)
  result.generated_at = new Date().toISOString()

  const outJson = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : join(ROOT, 'hallucination-score.json')
  writeFileSync(outJson, JSON.stringify(result, null, 2))

  console.log(`Hallucination Score: ${result.score} (${result.severity})`)
  for (const [k, c] of Object.entries(result.components)) {
    const tag = c.value === null ? 'n/a' : `${c.value} × ${c.weight} = ${c.contribution}`
    console.log(`  ${k.padEnd(14)} ${tag}`)
  }
  console.log(`  → ${relative(process.cwd(), outJson)}`)
}

if (process.argv[1]?.endsWith('hallucination-score.mjs')) {
  main()
}
