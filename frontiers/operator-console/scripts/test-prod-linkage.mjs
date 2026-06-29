#!/usr/bin/env node
// A4 — Test → prod-path linkage map.
//
// For every test file under tests/, extract:
//   • real (non-mock) imports that resolve to src/ or server.js
//   • traced endpoints (URL strings in fetch() / http.get() / msw http.* / supertest)
//
// Tests that import nothing from prod code OR trace zero endpoints are
// flagged as ORPHANS — they may pass without exercising the production path
// (= candidate hallucinations).
//
// Output: linkage-map.json + linkage-orphans.md
//
// Usage:
//   node scripts/test-prod-linkage.mjs
//   node scripts/test-prod-linkage.mjs --pattern='tests/unit/**' --out=link.json

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) acc[m[1]] = m[2] ?? true
  return acc
}, {})

const TEST_ROOT = join(ROOT, 'tests')
const OUT_JSON = args.out || join(ROOT, 'linkage-map.json')
const OUT_MD = args['out-md'] || join(ROOT, 'linkage-orphans.md')

// ── File walking ────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(test|spec)\.(m|c)?[jt]sx?$/.test(p)) out.push(p)
  }
  return out
}

// ── Per-file analyzer ───────────────────────────────────────────────────────
const RE_VIMOCK = /vi\.mock\(\s*['"`]([^'"`]+)['"`]/g
const RE_IMPORT = /^\s*import\s+[^'"]+from\s+['"`]([^'"`]+)['"`]/gm
const RE_DYN_IMPORT = /\bimport\(\s*['"`]([^'"`]+)['"`]/g
const RE_FETCH_URL = /\bfetch\(\s*['"`]([^'"`]+)['"`]/g
const RE_MSW_URL = /\bhttp\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g
const RE_SUPERTEST = /\.(get|post|put|delete|patch)\(\s*['"`](\/[^'"`]+)['"`]\)/g
const RE_BASEURL_FETCH = /\bfetch\(\s*`\$\{baseUrl\}([^`]+)`/g
// E2E (Playwright) — page.goto, page.route, baseURL are real prod-path traces
const RE_PAGE_GOTO = /\bpage\.goto\(\s*['"`]([^'"`]+)['"`]/g
const RE_PAGE_ROUTE = /\bpage\.route\(\s*['"`]([^'"`]+)['"`]/g
// Variable-arg Playwright calls (page.goto(path), page.goto(r.path)) still
// indicate the test exercises a prod surface, even if URL is dynamic.
const RE_PAGE_GOTO_VAR = /\bpage\.goto\(\s*[a-zA-Z_]/g
const RE_PAGE_ROUTE_VAR = /\bpage\.route\(\s*[a-zA-Z_]/g
// Discipline / audit tests read src files directly via fs
const RE_READ_SRC = /readFileSync\(\s*[^)]*['"`]([^'"`]*src[\\/][^'"`]+)['"`]/g
const RE_RESOLVE_SRC = /resolve\([^)]*['"`]([^'"`]*src[\\/][^'"`]+)['"`]/g

export function analyzeTest(file, content) {
  const mockedPaths = new Set()
  let m
  while ((m = RE_VIMOCK.exec(content))) mockedPaths.add(m[1])

  const imports = []
  while ((m = RE_IMPORT.exec(content))) imports.push(m[1])
  while ((m = RE_DYN_IMPORT.exec(content))) imports.push(m[1])

  const realImports = imports.filter(i => !mockedPaths.has(i))
  // Prod imports: relative paths, ~/ alias (mapped to src/ in vite.config),
  // and @hozan/*-ui workspace packages (re-export src/ via barrels).
  const prodImports = realImports.filter(i =>
    (/^[\.\/]/.test(i) || /^~\//.test(i) || /^@hozan\//.test(i)) &&
    !/[\\/]node_modules[\\/]/.test(i),
  )

  const endpoints = new Set()
  while ((m = RE_FETCH_URL.exec(content))) {
    if (m[1].startsWith('/') || /^https?:/.test(m[1])) endpoints.add(normalizeEndpoint(m[1]))
  }
  while ((m = RE_MSW_URL.exec(content))) endpoints.add(normalizeEndpoint(m[2]))
  while ((m = RE_SUPERTEST.exec(content))) endpoints.add(normalizeEndpoint(m[2]))
  while ((m = RE_BASEURL_FETCH.exec(content))) endpoints.add(normalizeEndpoint(m[1]))
  while ((m = RE_PAGE_GOTO.exec(content))) endpoints.add(normalizeEndpoint(m[1]))
  while ((m = RE_PAGE_ROUTE.exec(content))) endpoints.add(normalizeEndpoint(m[1]))
  if (RE_PAGE_GOTO_VAR.test(content)) endpoints.add('<dynamic:page.goto>')
  if (RE_PAGE_ROUTE_VAR.test(content)) endpoints.add('<dynamic:page.route>')

  // fs-based prod-path traces (audit/discipline tests)
  const fsReads = []
  while ((m = RE_READ_SRC.exec(content))) fsReads.push(m[1])
  while ((m = RE_RESOLVE_SRC.exec(content))) fsReads.push(m[1])
  for (const p of fsReads) prodImports.push(p)

  // Build-command runs are prod-path links (bundle budget, lighthouse)
  const buildLinked = /execSync\(\s*['"`]pnpm (build|exec)/i.test(content) ||
    /spawn\(\s*['"`]pnpm/i.test(content) ||
    /lighthouse/i.test(content) && /cli/i.test(content)
  if (buildLinked) prodImports.push('<build-output>')

  // Explicit opt-out for legitimate orphans (synthetic, e2e visual baselines)
  const allowed = /@linkage-allowed[:\s]/i.test(content)

  const finalProdImports = [...new Set(prodImports)]
  return {
    file: relative(ROOT, file),
    mockedPaths: [...mockedPaths],
    realImports,
    prodImports: finalProdImports,
    endpoints: [...endpoints],
    fsReads,
    allowed,
    isOrphan: !allowed && finalProdImports.length === 0 && endpoints.size === 0,
  }
}

export function normalizeEndpoint(url) {
  // Strip query strings, normalize :id placeholders
  let u = url.split('?')[0]
  // Remove protocol/host if present
  u = u.replace(/^https?:\/\/[^/]+/, '')
  // Replace numeric IDs with :id
  u = u.replace(/\/\d+(?=\/|$)/g, '/:id')
  return u || '/'
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const pattern = args.pattern
  const files = walk(TEST_ROOT).filter(f => !pattern || f.includes(pattern.replace(/\*+/g, '')))

  const rows = []
  for (const f of files) {
    const content = readFileSync(f, 'utf8')
    rows.push(analyzeTest(f, content))
  }

  const orphans = rows.filter(r => r.isOrphan)
  const summary = {
    total: rows.length,
    orphans: orphans.length,
    orphan_pct: rows.length === 0 ? 0 : Math.round((orphans.length / rows.length) * 100),
    avg_prod_imports: avg(rows.map(r => r.prodImports.length)),
    avg_endpoints: avg(rows.map(r => r.endpoints.length)),
    generated_at: new Date().toISOString(),
  }

  writeFileSync(OUT_JSON, JSON.stringify({ summary, rows }, null, 2))
  writeFileSync(OUT_MD, renderOrphanReport(rows, summary))

  console.log(`linkage-map: ${rows.length} tests, ${orphans.length} orphans (${summary.orphan_pct}%)`)
  console.log(`  → ${relative(process.cwd(), OUT_JSON)}`)
  console.log(`  → ${relative(process.cwd(), OUT_MD)}`)

  if (args.fail && summary.orphan_pct > Number(args.fail)) {
    console.error(`FAIL: orphan_pct ${summary.orphan_pct}% > threshold ${args.fail}%`)
    process.exit(1)
  }
}

function avg(arr) {
  if (arr.length === 0) return 0
  return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100
}

function renderOrphanReport(rows, summary) {
  const orphans = rows.filter(r => r.isOrphan)
  let md = `# Test Linkage Orphan Report — ${summary.generated_at.slice(0, 10)}\n\n`
  md += `- Total tests: **${summary.total}**\n`
  md += `- Orphans (no prod import + no endpoint): **${orphans.length}** (${summary.orphan_pct}%)\n`
  md += `- Avg prod imports/test: **${summary.avg_prod_imports}**\n`
  md += `- Avg endpoints/test: **${summary.avg_endpoints}**\n\n`
  if (orphans.length === 0) {
    md += `🟢 No orphans detected — every test traces at least one prod path.\n`
    return md
  }
  md += `## Orphan tests\n\n`
  md += `These tests neither import a file from \`src/\` nor trace any endpoint.\n`
  md += `They may be passing without exercising production code.\n\n`
  for (const o of orphans) {
    md += `- \`${o.file}\` — mocks: [${o.mockedPaths.join(', ') || 'none'}]\n`
  }
  return md
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('test-prod-linkage.mjs')) {
  main()
}
