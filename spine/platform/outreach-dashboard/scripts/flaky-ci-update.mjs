#!/usr/bin/env node
// H4 — Flaky test auto-quarantine CI script.
// Run after each CI test run; updates flaky_quarantine.json + opens issue.
//
// Usage:
//   node scripts/flaky-ci-update.mjs --run-log=path/to/vitest-output.json
//   node scripts/flaky-ci-update.mjs --stdin < vitest.json

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'

// HARDEN-5: atomic write helper. flaky-ci-update may run in parallel from
// multiple CI workers (matrix jobs). A naked writeFileSync can interleave
// half-written JSON. Write to temp + rename = POSIX-atomic.
function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}
import {
  recordRun,
  shouldQuarantine,
  shouldRestore,
  emptyHistory,
} from '../tests/helpers/flaky-quarantine.js'

const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) acc[m[1]] = m[2] ?? true
  return acc
}, {})

const HISTORY_PATH = resolve(import.meta.dirname, '../flaky-history.json')
const QUARANTINE_PATH = resolve(import.meta.dirname, '../flaky_quarantine.json')

let runLog
if (args['run-log']) runLog = JSON.parse(readFileSync(args['run-log'], 'utf8'))
else if (args.stdin) {
  runLog = JSON.parse(await new Promise(r => {
    let buf = ''
    process.stdin.on('data', c => (buf += c))
    process.stdin.on('end', () => r(buf))
  }))
} else {
  console.error('Usage: --run-log=<path> OR --stdin')
  process.exit(1)
}

// Load existing history (per-test rolling 10-run window)
let history = {}
if (existsSync(HISTORY_PATH)) history = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'))

// Load existing quarantine list
let quarantine = []
if (existsSync(QUARANTINE_PATH)) {
  const q = JSON.parse(readFileSync(QUARANTINE_PATH, 'utf8'))
  quarantine = Array.isArray(q.quarantined) ? q.quarantined : []
}
const quarantineSet = new Set(quarantine)

// Walk vitest run log → record each test outcome into history
let recordedCount = 0
for (const file of (runLog.testResults || [])) {
  for (const a of (file.assertionResults || [])) {
    const key = `${file.name.split('/').pop()}::${a.fullName || a.title}`
    if (!history[key]) history[key] = emptyHistory()
    history[key] = recordRun(history[key], { ok: a.status === 'passed', at: file.endTime })
    recordedCount++
  }
}

// Apply quarantine + restore decisions
const newlyQuarantined = []
const newlyRestored = []
for (const [key, h] of Object.entries(history)) {
  const isCurrentlyQuarantined = quarantineSet.has(key)
  if (!isCurrentlyQuarantined && shouldQuarantine(h.runs)) {
    quarantineSet.add(key)
    newlyQuarantined.push(key)
  }
  if (isCurrentlyQuarantined && shouldRestore(h.runs, { quarantined: true })) {
    quarantineSet.delete(key)
    newlyRestored.push(key)
  }
}

// Persist atomically (multiple CI workers may race the write)
atomicWrite(HISTORY_PATH, JSON.stringify(history, null, 2))
atomicWrite(QUARANTINE_PATH, JSON.stringify({
  generated_at: new Date().toISOString(),
  quarantined: [...quarantineSet].sort(),
  notes: 'Auto-managed by scripts/flaky-ci-update.mjs. Operator should review newly_quarantined entries weekly + investigate.',
}, null, 2))

// Report
console.log(`[flaky-ci-update] Processed ${recordedCount} test outcomes`)
console.log(`[flaky-ci-update] Currently quarantined: ${quarantineSet.size}`)
if (newlyQuarantined.length > 0) {
  console.log(`[flaky-ci-update] ⚠ Newly quarantined (${newlyQuarantined.length}):`)
  newlyQuarantined.forEach(k => console.log(`  - ${k}`))
}
if (newlyRestored.length > 0) {
  console.log(`[flaky-ci-update] ✓ Restored from quarantine (${newlyRestored.length}):`)
  newlyRestored.forEach(k => console.log(`  - ${k}`))
}

// Output for GH Actions: emit ::set-output (legacy) + GITHUB_OUTPUT (modern)
if (process.env.GITHUB_OUTPUT) {
  const out = `newly_quarantined=${newlyQuarantined.length}\nnewly_restored=${newlyRestored.length}\ntotal_quarantined=${quarantineSet.size}\n`
  writeFileSync(process.env.GITHUB_OUTPUT, out, { flag: 'a' })
}

// H5 — Auto-create GH issue when newly quarantined.
// Requires gh CLI configured + GITHUB_TOKEN env. Best-effort, swallows failures.
async function createIssue() {
  if (newlyQuarantined.length === 0) return
  if (!process.env.GITHUB_TOKEN || process.env.SKIP_GH_ISSUE === '1') return
  const { execFileSync } = await import('node:child_process')
  const title = `[flaky] ${newlyQuarantined.length} test(s) auto-quarantined`
  const body = [
    `## Newly quarantined tests`,
    ``,
    ...newlyQuarantined.map(k => `- \`${k}\``),
    ``,
    `## Action required`,
    `1. Investigate each test for root cause (race condition? timing? non-determinism?)`,
    `2. Fix or mark as known-flaky in test file`,
    `3. After 3 consecutive passes, test will auto-restore (no manual action needed)`,
    ``,
    `## Quarantine state`,
    `- Total currently quarantined: ${quarantineSet.size}`,
    `- Auto-managed by \`scripts/flaky-ci-update.mjs\``,
    ``,
    `_Generated automatically by flaky-quarantine CI workflow._`,
  ].join('\n')
  try {
    execFileSync('gh', ['issue', 'create',
      '--title', title,
      '--body', body,
      '--label', 'flaky-test,automated',
    ], { stdio: 'inherit' })
    console.log(`[flaky-ci-update] ✓ GH issue created`)
  } catch (e) {
    console.warn(`[flaky-ci-update] gh issue create failed: ${e?.message || e}`)
  }
}
await createIssue()

// Exit code: 0 if no new issues; 1 if newly quarantined (CI can flag)
process.exit(newlyQuarantined.length > 0 ? 1 : 0)
