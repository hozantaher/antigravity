#!/usr/bin/env node
// A7 — Pre-commit ratchet for hallucination score.
//
// Blocks a commit when:
//   1. Hallucination Score drops by more than --max-drop (default: 5)
//   2. Any newly-added test file has fewer than --min-asserts (default: 2)
//      assertions per it() block
//   3. Any newly-added test mocks a module but never invokes the real path
//      (heuristic: vi.mock present + zero imports of the same path)
//
// Wired in .githooks/pre-commit:
//   node apps/outreach-dashboard/scripts/halluc-precommit.mjs --staged

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeBlock, extractTestBlocks } from './assertion-density.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) acc[m[1]] = m[2] ?? true
  return acc
}, {})

const MAX_DROP = Number(args['max-drop'] || 5)
const MIN_ASSERTS = Number(args['min-asserts'] || 2)

// ── Score delta check ──────────────────────────────────────────────────────
export function checkScoreDelta({ current, prev, maxDrop }) {
  if (!current || !prev) return { ok: true, reason: 'no baseline yet' }
  const drop = (prev.score || 0) - (current.score || 0)
  if (drop > maxDrop) {
    return {
      ok: false,
      reason: `Hallucination Score dropped ${drop.toFixed(1)} pts (${prev.score} → ${current.score}); max allowed: ${maxDrop}`,
    }
  }
  return { ok: true, drop }
}

// ── New-test minimum-assertion check ───────────────────────────────────────
export function checkNewTestAssertions(stagedFiles, getContent, minAsserts = MIN_ASSERTS) {
  const violations = []
  for (const f of stagedFiles) {
    if (!/\.(test|spec)\.(m|c)?[jt]sx?$/.test(f)) continue
    const content = getContent(f)
    if (content == null) continue // not added/modified
    const blocks = extractTestBlocks(content)
    for (const b of blocks) {
      const r = analyzeBlock(b.name, b.body)
      if (r.expectCount < minAsserts) {
        violations.push({
          file: f,
          block: b.name,
          assertions: r.expectCount,
        })
      }
    }
  }
  return violations
}

// ── Mock-without-real-import heuristic ─────────────────────────────────────
export function checkMockWithoutImport(stagedFiles, getContent) {
  const violations = []
  for (const f of stagedFiles) {
    if (!/\.(test|spec)\.(m|c)?[jt]sx?$/.test(f)) continue
    const content = getContent(f)
    if (content == null) continue
    const mocked = [...content.matchAll(/vi\.mock\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1])
    const imports = [...content.matchAll(/from\s+['"`]([^'"`]+)['"`]/g)].map(m => m[1])
    const dynamicImports = [...content.matchAll(/import\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1])
    const allImports = new Set([...imports, ...dynamicImports])
    for (const m of mocked) {
      if (!allImports.has(m)) {
        violations.push({ file: f, mocked: m, reason: 'mocked but not imported — production path never reached' })
      }
    }
  }
  return violations
}

// ── Git staged-file extraction ─────────────────────────────────────────────
export function getStagedFiles(execImpl = execSync) {
  try {
    const out = execImpl('git diff --cached --name-only --diff-filter=AM', { encoding: 'utf8' })
    return out.split('\n').map(s => s.trim()).filter(Boolean)
  } catch (e) {
    return []
  }
}

export function getStagedContent(file, execImpl = execSync) {
  try {
    return execImpl(`git show ":${file}"`, { encoding: 'utf8' })
  } catch (e) {
    return null
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const errors = []

  // 1. Score-delta check
  const cur = existsSync(join(ROOT, 'hallucination-score.json'))
    ? JSON.parse(readFileSync(join(ROOT, 'hallucination-score.json'), 'utf8'))
    : null
  const baselinePath = join(ROOT, 'hallucination-score.baseline.json')
  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : null
  const delta = checkScoreDelta({ current: cur, prev: baseline, maxDrop: MAX_DROP })
  if (!delta.ok) errors.push(`SCORE: ${delta.reason}`)

  // 2/3. Per-file checks on staged content
  const staged = getStagedFiles().filter(f => f.startsWith('apps/outreach-dashboard/'))
    .map(f => f.replace('apps/outreach-dashboard/', ''))
  const getContent = f => getStagedContent('apps/outreach-dashboard/' + f)
  const lowAssert = checkNewTestAssertions(staged, getContent, MIN_ASSERTS)
  for (const v of lowAssert) errors.push(`ASSERT: ${v.file} :: "${v.block}" has only ${v.assertions} assertion(s)`)
  const mockBad = checkMockWithoutImport(staged, getContent)
  for (const v of mockBad) errors.push(`MOCK: ${v.file} mocks "${v.mocked}" but never imports it`)

  if (errors.length === 0) {
    console.log(`hallucination ratchet: OK (score ${cur?.score ?? 'n/a'}, ${staged.length} staged files checked)`)
    process.exit(0)
  }
  console.error(`hallucination ratchet: BLOCKED — ${errors.length} issue(s):`)
  for (const e of errors) console.error(`  • ${e}`)
  console.error(`\nIf intentional, regenerate baseline:`)
  console.error(`  node scripts/hallucination-score.mjs && cp hallucination-score.json hallucination-score.baseline.json`)
  process.exit(1)
}

if (process.argv[1]?.endsWith('halluc-precommit.mjs')) {
  main()
}
