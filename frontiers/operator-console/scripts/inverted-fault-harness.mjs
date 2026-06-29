#!/usr/bin/env node
// A2 — Inverted-fault harness.
//
// Rewrites every vi.mock() factory in a test file so it throws
// when the mocked module is invoked. A test that still passes after
// inversion was not exercising the mocked production path.
//
// Workflow:
//   1. Read each test file
//   2. Apply invertMockFactories() — produces shadow source where each
//      vi.mock(path, factory) is replaced with vi.mock(path, () => ({
//        default: () => { throw INVERT_ERR }, ... })
//   3. Write shadow file to .inverted-shadow/<rel-path>
//   4. Run vitest on shadow files
//   5. Tests that still pass are tagged as no-signal candidates
//
// Output: inverted-fault-report.json + inverted-fault-report.md
//
// Usage:
//   node scripts/inverted-fault-harness.mjs --dry            (transform only)
//   node scripts/inverted-fault-harness.mjs --run            (transform + run)
//   node scripts/inverted-fault-harness.mjs --pattern='tests/unit/components/**'

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

// ROOT must be apps/outreach-dashboard regardless of how this module is
// loaded (node CLI vs vitest worker). Use fileURLToPath which behaves
// consistently — `new URL('..', meta).pathname` produced bogus paths
// inside vitest workers (returned `/tests/unit` instead of the absolute
// path), causing shadow files to leak into real test directories.
const __filename = fileURLToPath(import.meta.url)
const ROOT = resolve(__filename, '..', '..')
const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) acc[m[1]] = m[2] ?? true
  return acc
}, {})

const SHADOW_ROOT = args.shadow || join(ROOT, '.inverted-shadow')
const TEST_ROOT = join(ROOT, 'tests', 'unit')
const INVERT_ERR_MSG = '__INVERTED_FAULT__'

// ── Walk ────────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(test|spec)\.(m|c)?[jt]sx?$/.test(p)) out.push(p)
  }
  return out
}

// ── Source transformer ─────────────────────────────────────────────────────
// Strategy: locate each vi.mock(<path>, <factory>) call, replace the factory
// arg with a throwing factory. We use a brace-balancing scanner (same as A3).

const RE_VIMOCK_HEAD = /\bvi\.mock\(\s*['"`]([^'"`]+)['"`]/g

export function invertMockFactories(source) {
  // Walk every vi.mock( site
  const out = []
  let cursor = 0
  let m
  while ((m = RE_VIMOCK_HEAD.exec(source))) {
    const start = m.index
    const headEnd = start + m[0].length
    // After the path, look for `,` then factory expression up to matching `)`
    const tail = source.slice(headEnd)
    const commaIdx = tail.search(/[,)]/)
    if (commaIdx === -1) continue
    const callOpenIdx = headEnd + commaIdx
    if (source[callOpenIdx] === ')') {
      // No factory — skip (vi.mock with auto-mock; rare)
      out.push(source.slice(cursor, callOpenIdx + 1))
      cursor = callOpenIdx + 1
      RE_VIMOCK_HEAD.lastIndex = cursor
      continue
    }
    // We have a comma; find the end of the factory by matching parens
    const factoryStart = callOpenIdx + 1
    const callEnd = findMatchingCloseParen(source, start + 'vi.mock('.length - 1)
    if (callEnd === -1) continue
    // Replace the factory portion with throwing factory.
    // Preserve the closing `)` of the vi.mock call by stopping cursor
    // one char before it.
    const inverted = `() => { throw new Error('${INVERT_ERR_MSG}') }`
    out.push(source.slice(cursor, factoryStart))
    out.push(' ' + inverted)
    cursor = callEnd - 1 // leave the original `)` for the next slice
    RE_VIMOCK_HEAD.lastIndex = cursor
  }
  out.push(source.slice(cursor))
  return out.join('')
}

function findMatchingCloseParen(content, openIdx) {
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
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

// ── No-signal classifier ───────────────────────────────────────────────────
// After running inverted shadow, parse vitest --reporter=json output.
// A test that PASSES with all its mocks throwing has no contact with prod
// code → "no-signal" candidate.
export function classifyResults(originalReport, invertedReport) {
  const findings = []
  const origByName = indexByName(originalReport)
  const invByName = indexByName(invertedReport)
  for (const [name, origStatus] of origByName) {
    if (origStatus !== 'passed') continue
    const invStatus = invByName.get(name)
    if (invStatus === 'passed') {
      findings.push({ name, kind: 'no-signal', reason: 'pass with mocks throwing — does not exercise production path' })
    } else if (invStatus === 'failed') {
      findings.push({ name, kind: 'good-signal' })
    } else {
      findings.push({ name, kind: 'inconclusive', reason: 'inverted variant did not run' })
    }
  }
  return findings
}

function indexByName(report) {
  const map = new Map()
  if (!report?.testResults) return map
  for (const file of report.testResults) {
    for (const t of file.assertionResults || []) {
      const key = `${file.name}::${t.fullName || t.title}`
      map.set(key, t.status)
    }
  }
  return map
}

// ── Shadow writer ──────────────────────────────────────────────────────────
// Defensive: verify dst is inside the resolved shadowRoot before writing
// so a misconfigured path can't leak transformed (non-test) files into the
// real test tree. Earlier versions trusted relative() — but path traversal
// from `..` or absolute originals on case-insensitive filesystems could
// escape. Guard against this explicitly.
export function writeShadowFile(originalPath, source, shadowRoot = SHADOW_ROOT) {
  const absShadow = resolve(shadowRoot)
  const rel = relative(ROOT, originalPath)
  const dst = resolve(absShadow, rel)
  if (!dst.startsWith(absShadow + '/') && dst !== absShadow) {
    throw new Error(`writeShadowFile refused: dst (${dst}) escapes shadowRoot (${absShadow})`)
  }
  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, invertMockFactories(source))
  return dst
}

// ── Vitest runner integration ───────────────────────────────────────────────
// Runs vitest twice on the same set of test files: once original, once
// against the shadow (mocks throw). A test that PASSES in both runs has
// no contact with the production path it claims to test.
export async function runVitestJson(files, { cwd = ROOT, env = {}, timeoutMs = 600_000 } = {}) {
  if (files.length === 0) return { testResults: [] }
  const tmpReport = join(SHADOW_ROOT, `report-${Date.now()}.json`)
  mkdirSync(dirname(tmpReport), { recursive: true })
  const list = files.join(' ')
  try {
    execSync(
      `npx vitest run --reporter=json --outputFile=${tmpReport} ${list}`,
      { cwd, env: { ...process.env, ...env }, stdio: 'pipe', timeout: timeoutMs },
    )
  } catch (e) {
    // Non-zero exit is expected when tests fail; we still parse the report.
  }
  if (!existsSync(tmpReport)) return { testResults: [] }
  return JSON.parse(readFileSync(tmpReport, 'utf8'))
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (existsSync(SHADOW_ROOT) && !args.keep) rmSync(SHADOW_ROOT, { recursive: true, force: true })
  mkdirSync(SHADOW_ROOT, { recursive: true })

  const files = walk(TEST_ROOT)
  let transformed = 0
  let untouched = 0
  const shadowFiles = []
  const originalFiles = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    if (!/vi\.mock\(/.test(src)) { untouched++; continue }
    const dst = writeShadowFile(f, src)
    shadowFiles.push(dst)
    originalFiles.push(f)
    transformed++
  }

  console.log(`inverted-fault: ${transformed} files transformed → ${relative(process.cwd(), SHADOW_ROOT)}/`)
  console.log(`  ${untouched} files had no vi.mock() — skipped.`)
  if (!args.run) {
    console.log(`  Pass --run to also execute and classify (slow).`)
    return
  }

  console.log(`Running originals (${originalFiles.length} files)…`)
  const originalReport = await runVitestJson(originalFiles)
  console.log(`Running shadows (${shadowFiles.length} files)…`)
  const invertedReport = await runVitestJson(shadowFiles)

  const findings = classifyResults(originalReport, invertedReport)
  const summary = {
    total_classified: findings.length,
    no_signal: findings.filter(f => f.kind === 'no-signal').length,
    good_signal: findings.filter(f => f.kind === 'good-signal').length,
    inconclusive: findings.filter(f => f.kind === 'inconclusive').length,
    generated_at: new Date().toISOString(),
  }

  const out = join(ROOT, 'inverted-fault-report.json')
  writeFileSync(out, JSON.stringify({ summary, findings }, null, 2))
  console.log(`inverted-fault-report: no-signal=${summary.no_signal}/${summary.total_classified}`)
  console.log(`  → ${relative(process.cwd(), out)}`)

  if (args.fail && summary.no_signal > Number(args.fail)) {
    console.error(`FAIL: ${summary.no_signal} no-signal tests > threshold ${args.fail}`)
    process.exit(1)
  }
}

if (process.argv[1]?.endsWith('inverted-fault-harness.mjs')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
