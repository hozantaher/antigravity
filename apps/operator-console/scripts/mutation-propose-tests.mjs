#!/usr/bin/env node
// L7 — Mutation testing → propose tests for surviving mutants.
// Reads Stryker's mutation report (JSON) → identifies surviving mutants
// → emits markdown with one test proposal per mutant.
//
// Surviving mutant = mutation Stryker introduced that NO test killed.
// Each survivor reveals a coverage gap. Operator reviews proposals →
// adds real tests in tests/unit/ → reruns Stryker.
//
// Usage:
//   node scripts/mutation-propose-tests.mjs --report=reports/mutation/mutation.json
//   node scripts/mutation-propose-tests.mjs --report=...  --max=20

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) acc[m[1]] = m[2] ?? true
  return acc
}, {})

const reportPath = args.report || './reports/mutation/mutation.json'
if (!existsSync(reportPath)) {
  console.error(`Mutation report not found: ${reportPath}`)
  console.error(`Run: pnpm exec stryker run stryker.bottleneck.config.json`)
  process.exit(1)
}

let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (e) {
  console.error('Failed to parse report:', e.message)
  process.exit(2)
}

const MAX_PROPOSALS = parseInt(args.max || '50')

// Stryker schema: { files: { [path]: { mutants: [...] } } }
const survivors = []
for (const [path, fileData] of Object.entries(report.files || {})) {
  for (const mutant of (fileData.mutants || [])) {
    if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') {
      survivors.push({
        file: path,
        line: mutant.location?.start?.line ?? '?',
        mutator: mutant.mutatorName || mutant.mutator,
        original: mutant.original?.slice(0, 120),
        replacement: mutant.replacement?.slice(0, 120),
        status: mutant.status,
      })
    }
  }
}

// Sort by file + line for deterministic output
survivors.sort((a, b) => (a.file + ':' + a.line).localeCompare(b.file + ':' + b.line))

const top = survivors.slice(0, MAX_PROPOSALS)

console.log(`# Mutation Test Proposals — ${new Date().toISOString().slice(0, 10)}\n`)
console.log(`Report: \`${reportPath}\``)
console.log(`Surviving mutants: **${survivors.length}** (showing top ${top.length})\n`)
console.log(`---\n`)

for (let i = 0; i < top.length; i++) {
  const s = top[i]
  console.log(`## Proposal #${i + 1}: \`${s.file}:${s.line}\`\n`)
  console.log(`**Mutator**: \`${s.mutator}\` — status: \`${s.status}\``)
  console.log(`\n**Original code:**\n\`\`\`\n${s.original}\n\`\`\``)
  console.log(`\n**Mutated code (survived — no test caught it):**\n\`\`\`\n${s.replacement}\n\`\`\``)
  console.log(`\n**Suggested test:**`)
  console.log(`Add a test case that distinguishes the original from the mutation.`)
  console.log(`If the mutation involves a comparison, test boundary values on both sides.`)
  console.log(`If the mutation involves a return value, assert exact value.\n`)
  console.log(`---\n`)
}

if (survivors.length === 0) {
  console.log(`✓ No surviving mutants — full kill rate. Mutation testing exhausted.`)
}

if (survivors.length > MAX_PROPOSALS) {
  console.log(`\n_${survivors.length - MAX_PROPOSALS} more proposals omitted. Re-run with --max=N for more._`)
}
