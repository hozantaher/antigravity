#!/usr/bin/env node
// A3 — Assertion density + tautology audit.
//
// For every test file, parse each `it(…)` / `test(…)` block and:
//   • count expect() calls
//   • flag blocks with < 2 expect() calls (no-signal candidate)
//   • flag tautological assertions:
//       expect(true).toBe(true)        — constant truthy
//       expect(false).toBe(false)      — constant falsy
//       expect(1).toBe(1)              — same literal
//       expect(getX()).toBe(getX())    — same expression both sides
//       expect(undefined).toBe(undefined)
//   • flag “toBeDefined-only” blocks (assertion without value check)
//
// Output: assertion-audit.json + assertion-audit.md
//
// Usage:
//   node scripts/assertion-density.mjs
//   node scripts/assertion-density.mjs --min=2 --fail-on-violation

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) acc[m[1]] = m[2] ?? true
  return acc
}, {})

// Default: 1 assertion per it() block. A block with 0 assertions is "no
// signal" — passes regardless of behavior. Single-assertion tests are valid
// (boundary tests, parametric cases). Override via --min=N.
const MIN_ASSERTIONS = Number(args.min || 1)
const TEST_ROOT = join(ROOT, 'tests')

function walk(dir, out = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(test|spec)\.(m|c)?[jt]sx?$/.test(p)) out.push(p)
  }
  return out
}

// ── Block extraction ────────────────────────────────────────────────────────
// We split content into per-test blocks. A test block starts at `it(`/`test(`/`fit(`
// and ends at the matching closing paren. We don't need a full AST — a
// brace-matching scanner is good enough for our purposes.

export function extractTestBlocks(content) {
  const blocks = []
  const re = /\b(it|test|fit)(\.\w+)?\(\s*['"`]([^'"`]+)['"`]/g
  let m
  while ((m = re.exec(content))) {
    const startIdx = m.index
    const name = m[3]
    // Find end of block: walk forward, balance parens (but skip strings + comments)
    const end = findMatchingParenEnd(content, startIdx + m[0].length - 1)
    if (end === -1) continue
    const body = content.slice(startIdx, end + 1)
    blocks.push({ name, body, start: startIdx, end })
  }
  return blocks
}

function findMatchingParenEnd(content, openIdx) {
  let depth = 1
  let i = openIdx + 1
  let inStr = null
  let inTpl = false
  let inLineCmt = false
  let inBlockCmt = false
  while (i < content.length) {
    const c = content[i]
    const next = content[i + 1]
    if (inLineCmt) {
      if (c === '\n') inLineCmt = false
    } else if (inBlockCmt) {
      if (c === '*' && next === '/') { inBlockCmt = false; i++ }
    } else if (inStr) {
      if (c === '\\') i++
      else if (c === inStr) inStr = null
    } else if (inTpl) {
      if (c === '\\') i++
      else if (c === '`') inTpl = false
    } else if (c === '/' && next === '/') {
      inLineCmt = true; i++
    } else if (c === '/' && next === '*') {
      inBlockCmt = true; i++
    } else if (c === '"' || c === "'") {
      inStr = c
    } else if (c === '`') {
      inTpl = true
    } else if (c === '(') {
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

// ── Assertion analysis ──────────────────────────────────────────────────────
// `expect(...)` itself, `expect.something(...)`, AND `expectXxx(...)` helpers
// (e.g. expectSqlstate, expectSafeResponse, expectThrows) which are common
// in our codebase. Match any `expect[A-Z]\w*\(` shape.
const RE_EXPECT = /\b(?:expect(?:\.\w+|[A-Z]\w*)?)\s*\(/g
// Equivalents to expect: fast-check fc.assert, custom assertX helpers
// (camelCase or PascalCase suffix: assertSafeResponse, assertEqual, etc.),
// vitest assert(), node:assert, invariant() macros.
const RE_OTHER_ASSERTIONS = /\b(fc\.assert|assert[A-Z]\w*|assert|invariant)\s*\(/g
const RE_EXPECT_FULL = /\bexpect\(\s*([^)]*?)\s*\)\s*\.\s*([\w]+)\s*\(\s*([^)]*?)\s*\)/g

const TRIVIAL_VALUES = new Set(['true', 'false', '1', '0', '""', "''", '`'.repeat(2), 'null', 'undefined', 'NaN'])
const SAFE_MATCHERS = new Set(['toBeDefined', 'toBeUndefined', 'toBeTruthy', 'toBeFalsy', 'toBeNull'])

export function analyzeBlock(name, body) {
  const expectOnlyCount = (body.match(RE_EXPECT) || []).length
  const otherAssertionCount = (body.match(RE_OTHER_ASSERTIONS) || []).length
  const expectCount = expectOnlyCount + otherAssertionCount
  const flags = []
  const tautologies = []

  // Detect tautology pairs
  let m
  RE_EXPECT_FULL.lastIndex = 0
  while ((m = RE_EXPECT_FULL.exec(body))) {
    const [, lhs, matcher, rhs] = m
    const a = lhs.trim()
    const b = rhs.trim()
    if (a === b && a !== '') {
      tautologies.push(`expect(${a}).${matcher}(${b}) — both sides identical`)
    } else if (TRIVIAL_VALUES.has(a) && TRIVIAL_VALUES.has(b) && a === b) {
      tautologies.push(`expect(${a}).${matcher}(${b}) — constant tautology`)
    } else if (matcher === 'toBe' && (a === 'true' || a === 'false' || a === '1' || a === '0') && a === b) {
      tautologies.push(`expect(${a}).${matcher}(${b}) — constant tautology`)
    }
  }

  // Detect "only safe matchers" (toBeDefined alone)
  const matcherChain = [...body.matchAll(/\.\s*(\w+)\s*\(/g)].map(x => x[1])
  const usedMatchers = new Set(matcherChain.filter(c => /^to[A-Z]/.test(c)))
  if (expectCount > 0 && usedMatchers.size > 0 && [...usedMatchers].every(c => SAFE_MATCHERS.has(c))) {
    flags.push('only-safe-matchers')
  }

  // Density flag
  if (expectCount < MIN_ASSERTIONS) flags.push(`low-density (${expectCount} < ${MIN_ASSERTIONS})`)
  if (tautologies.length > 0) flags.push('tautology')

  return { name, expectCount, flags, tautologies }
}

// ── File-level analyzer ─────────────────────────────────────────────────────
// Files marked with `@tautology-fixtures` (legacy alias) or
// `@analyzer-self-test` (preferred) contain code-as-strings — fixture data
// fed to the analyzer they test. These trigger both tautology and zero-
// assertion false positives. Suppress both flags for marked files.
export function analyzeFile(file, content) {
  const blocks = extractTestBlocks(content)
  const fixtureFile = /@(tautology-fixtures|analyzer-self-test|density-fixtures)\b/i.test(content)
  const analyzed = blocks.map(b => {
    const r = analyzeBlock(b.name, b.body)
    if (fixtureFile) {
      // Suppress fixture-driven false positives
      r.tautologies = []
      r.flags = r.flags.filter(f => f !== 'tautology' && !f.startsWith('low-density'))
    }
    return r
  })
  // Use flags as source of truth so the @analyzer-self-test marker
  // properly zeros out aggregate counts (flags are suppressed first).
  const lowDensity = analyzed.filter(b => b.flags.some(f => f.startsWith('low-density'))).length
  const tautologies = analyzed.filter(b => b.tautologies.length > 0)
  return {
    file: relative(ROOT, file),
    total: analyzed.length,
    avg_expects: analyzed.length === 0 ? 0
      : Math.round((analyzed.reduce((s, b) => s + b.expectCount, 0) / analyzed.length) * 100) / 100,
    low_density: lowDensity,
    tautology_count: tautologies.length,
    blocks: analyzed.filter(b => b.flags.length > 0),
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const files = walk(TEST_ROOT)
  const rows = files.map(f => analyzeFile(f, readFileSync(f, 'utf8')))

  const flagged = rows.filter(r => r.blocks.length > 0)
  const totalBlocks = rows.reduce((s, r) => s + r.total, 0)
  const totalLow = rows.reduce((s, r) => s + r.low_density, 0)
  const totalTaut = rows.reduce((s, r) => s + r.tautology_count, 0)

  const summary = {
    files: rows.length,
    test_blocks: totalBlocks,
    low_density_blocks: totalLow,
    tautology_blocks: totalTaut,
    low_density_pct: totalBlocks === 0 ? 0 : Math.round((totalLow / totalBlocks) * 100),
    generated_at: new Date().toISOString(),
  }

  const outJson = args.out || join(ROOT, 'assertion-audit.json')
  const outMd = args['out-md'] || join(ROOT, 'assertion-audit.md')
  writeFileSync(outJson, JSON.stringify({ summary, rows: flagged }, null, 2))
  writeFileSync(outMd, renderMd(flagged, summary))

  console.log(`assertion-audit: ${totalBlocks} blocks, ${totalLow} low-density (${summary.low_density_pct}%), ${totalTaut} tautology`)
  console.log(`  → ${relative(process.cwd(), outJson)}`)
  console.log(`  → ${relative(process.cwd(), outMd)}`)

  if (args['fail-on-violation'] && (totalLow + totalTaut) > 0) {
    console.error(`FAIL: assertion-density violations found`)
    process.exit(1)
  }
}

function renderMd(rows, s) {
  let md = `# Assertion Density Audit — ${s.generated_at.slice(0, 10)}\n\n`
  md += `- Test files: **${s.files}**\n`
  md += `- Total it/test blocks: **${s.test_blocks}**\n`
  md += `- Low-density (< ${MIN_ASSERTIONS} expects): **${s.low_density_blocks}** (${s.low_density_pct}%)\n`
  md += `- Tautology blocks: **${s.tautology_blocks}**\n\n`
  if (rows.length === 0) {
    md += `🟢 No flagged blocks.\n`
    return md
  }
  md += `## Flagged blocks\n\n`
  for (const r of rows.slice(0, 100)) {
    md += `### \`${r.file}\`\n\n`
    for (const b of r.blocks) {
      md += `- **${b.name}** — flags: ${b.flags.join(', ')}\n`
      for (const t of b.tautologies) md += `  - ⚠️ ${t}\n`
    }
    md += `\n`
  }
  return md
}

if (process.argv[1]?.endsWith('assertion-density.mjs')) {
  main()
}
