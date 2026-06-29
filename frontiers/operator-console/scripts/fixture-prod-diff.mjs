#!/usr/bin/env node
// A1 — Fixture-from-prod regenerator + drift detector.
//
// 1. Calls live BFF for each known endpoint
// 2. Compares the prod shape against the active MSW handler return shape
// 3. Reports "drift" entries — fields added/removed/type-changed
//
// The intent: catch hallucination class "fixture diverged from prod schema",
// where unit tests pass against fake shapes that never reach prod.
//
// Output: fixture-drift.json + fixture-drift.md
//
// Usage:
//   OUTREACH_API_KEY=xxx node scripts/fixture-prod-diff.mjs --target=https://prod-bff
//   node scripts/fixture-prod-diff.mjs --target=http://localhost:3100 --endpoint='/api/health'

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) acc[m[1]] = m[2] ?? true
  return acc
}, {})

const TARGET = args.target || process.env.SYNTHETIC_TARGET_URL || 'http://localhost:3100'
const HEADERS = process.env.OUTREACH_API_KEY
  ? { 'x-api-key': process.env.OUTREACH_API_KEY }
  : {}
const TIMEOUT_MS = Number(args.timeout || 5000)

// Default endpoint set (extend as new ones are added). Each must be safe,
// idempotent, and require no body.
const DEFAULT_ENDPOINTS = [
  '/api/health',
  '/api/health/system',
  '/api/health/invariants',
  '/api/replies/stats',
  '/api/templates',
  '/api/segments',
  '/api/synthetic-runs?limit=10',
  '/api/dashboard/overview',
  '/api/diagnostics/segmentation',
  '/api/proxy-pool',
  '/api/__schema-check',
]

// ── Shape inference (recursive) ─────────────────────────────────────────────
export function inferShape(value, depth = 0) {
  if (depth > 6) return '<deep>'
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array<unknown>'
    // Use first element shape; mark heterogeneous arrays
    const first = inferShape(value[0], depth + 1)
    const allSame = value.every(v => inferShape(v, depth + 1) === first)
    return allSame ? `array<${first}>` : `array<heterogeneous>`
  }
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) {
      out[k] = inferShape(value[k], depth + 1)
    }
    return out
  }
  return typeof value
}

// ── Diff two shapes ─────────────────────────────────────────────────────────
export function diffShapes(prod, fixture, path = '') {
  const drift = []
  if (typeof prod !== typeof fixture) {
    drift.push({ path, kind: 'type-change', from: typeof fixture, to: typeof prod })
    return drift
  }
  if (typeof prod === 'string' && typeof fixture === 'string') {
    if (prod !== fixture) drift.push({ path, kind: 'leaf-type', from: fixture, to: prod })
    return drift
  }
  if (Array.isArray(prod) || Array.isArray(fixture)) {
    if (Array.isArray(prod) !== Array.isArray(fixture)) {
      drift.push({ path, kind: 'array-vs-object' })
    }
    return drift
  }
  if (prod === null || fixture === null) {
    if (prod !== fixture) drift.push({ path, kind: 'null-mismatch' })
    return drift
  }
  // Object
  if (typeof prod === 'object' && typeof fixture === 'object') {
    const prodKeys = new Set(Object.keys(prod))
    const fixtureKeys = new Set(Object.keys(fixture))
    for (const k of prodKeys) {
      if (!fixtureKeys.has(k)) drift.push({ path: path + '.' + k, kind: 'fixture-missing-field' })
      else drift.push(...diffShapes(prod[k], fixture[k], path + '.' + k))
    }
    for (const k of fixtureKeys) {
      if (!prodKeys.has(k)) drift.push({ path: path + '.' + k, kind: 'fixture-extra-field' })
    }
  }
  return drift
}

// ── MSW fixture loader ──────────────────────────────────────────────────────
// We read tests/setup.js handlers. Best-effort regex; refines over time.
const SETUP_FILE = join(ROOT, 'src', 'test', 'setup.js')
export function loadFixturesFromSetup() {
  if (!existsSync(SETUP_FILE)) return {}
  const src = readFileSync(SETUP_FILE, 'utf8')
  const fixtures = {}
  // Match http.get('/api/x', () => HttpResponse.json(EXPR))
  const re = /http\.get\(\s*['"`]([^'"`]+)['"`][^)]*?HttpResponse\.json\(\s*([A-Z_][A-Z0-9_]*)\s*\)/g
  let m
  while ((m = re.exec(src))) {
    fixtures[m[1]] = { constName: m[2] }
  }
  return fixtures
}

// ── Fetch with timeout ──────────────────────────────────────────────────────
export async function fetchEndpoint(target, path) {
  const url = target.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path)
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctl.signal })
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` }
    const body = await r.json()
    return { ok: true, status: r.status, shape: inferShape(body), sample: body }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    clearTimeout(t)
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const endpoints = args.endpoint
    ? [args.endpoint]
    : DEFAULT_ENDPOINTS

  const fixtures = loadFixturesFromSetup()
  const results = []

  for (const ep of endpoints) {
    const r = await fetchEndpoint(TARGET, ep)
    const path = ep.split('?')[0]
    const fixtureMeta = fixtures[path] || null
    results.push({ endpoint: ep, ok: r.ok, status: r.status, error: r.error, shape: r.shape, fixture: fixtureMeta })
  }

  const reachable = results.filter(r => r.ok).length
  const summary = {
    target: TARGET,
    endpoints: endpoints.length,
    reachable,
    fixture_known: Object.keys(fixtures).length,
    generated_at: new Date().toISOString(),
  }

  const outJson = args.out || join(ROOT, 'fixture-drift.json')
  const outMd = args['out-md'] || join(ROOT, 'fixture-drift.md')
  writeFileSync(outJson, JSON.stringify({ summary, results }, null, 2))
  writeFileSync(outMd, renderMd(results, summary))

  console.log(`fixture-drift: ${reachable}/${endpoints.length} reachable`)
  console.log(`  → ${relative(process.cwd(), outJson)}`)
  console.log(`  → ${relative(process.cwd(), outMd)}`)
}

function renderMd(results, s) {
  let md = `# Fixture Drift Report — ${s.generated_at.slice(0, 10)}\n\n`
  md += `Target: \`${s.target}\`\n\n`
  md += `- Endpoints probed: **${s.endpoints}**\n`
  md += `- Reachable: **${s.reachable}**\n`
  md += `- Fixtures known (in src/test/setup.js): **${s.fixture_known}**\n\n`
  for (const r of results) {
    md += `## \`${r.endpoint}\`\n\n`
    if (!r.ok) md += `🔴 unreachable: ${r.error || `status ${r.status}`}\n\n`
    else {
      md += `🟢 reachable (status ${r.status})\n\n`
      md += `**Inferred prod shape:**\n\n\`\`\`json\n${JSON.stringify(r.shape, null, 2)}\n\`\`\`\n\n`
      if (r.fixture) {
        md += `**Active MSW fixture constant:** \`${r.fixture.constName}\` — verify shape parity manually until A5 (snapshot diff) lands.\n\n`
      } else {
        md += `⚠️ No MSW fixture detected for this endpoint — unit-test path may not cover it.\n\n`
      }
    }
  }
  return md
}

if (process.argv[1]?.endsWith('fixture-prod-diff.mjs')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
