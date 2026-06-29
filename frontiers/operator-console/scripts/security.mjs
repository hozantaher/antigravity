#!/usr/bin/env node
// Security probe — pnpm audit + license inventory.
// Writes reports/security/{audit.json, licenses.json}. Read by
// src/security.audit.test.js. Audit baselines + license whitelist
// live in the test, not here. This script just collects.
//
// Run: node scripts/security.mjs

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('reports/security', { recursive: true })

// ── pnpm audit ─────────────────────────────────────────────────────
process.stderr.write('pnpm audit ... ')
const audit = spawnSync('pnpm', ['audit', '--json'], { encoding: 'utf8' })
let auditJson = {}
try { auditJson = JSON.parse(audit.stdout) }
catch { auditJson = { error: 'unparseable', raw: audit.stdout?.slice(0, 500) } }
const meta = auditJson.metadata?.vulnerabilities || {}
process.stderr.write(`done (${meta.critical || 0} crit, ${meta.high || 0} high, ${meta.moderate || 0} mod)\n`)
writeFileSync('reports/security/audit.json', JSON.stringify(auditJson, null, 2))

// ── license inventory ──────────────────────────────────────────────
// Walk monorepo's .pnpm store entries — that's the actual installed set.
process.stderr.write('license walk ... ')
const PNPM_DIR = '../../../node_modules/.pnpm'
const licenses = []
if (existsSync(PNPM_DIR)) {
  for (const entry of readdirSync(PNPM_DIR)) {
    if (entry.startsWith('.')) continue
    const pkgRoot = join(PNPM_DIR, entry, 'node_modules')
    if (!existsSync(pkgRoot)) continue
    // Each .pnpm/<x>@<v>/node_modules contains the actual package + its peers.
    // The actual package matches the entry's leading name component.
    const wanted = entry.split('@').slice(0, -1).join('@').replace(/\+/g, '/').split('_')[0]
    if (!wanted) continue
    const pkgPath = join(pkgRoot, wanted, 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const j = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const lic = typeof j.license === 'string'
        ? j.license
        : (j.license?.type || (Array.isArray(j.licenses) ? j.licenses.map(x => x.type).join(' OR ') : 'UNKNOWN'))
      licenses.push({ name: j.name, version: j.version, license: lic || 'UNKNOWN' })
    } catch {}
  }
}

// Dedupe by name+version.
const dedup = new Map()
for (const l of licenses) dedup.set(`${l.name}@${l.version}`, l)
const all = [...dedup.values()].sort((a, b) => a.name.localeCompare(b.name))
const byLicense = {}
for (const l of all) byLicense[l.license] = (byLicense[l.license] || 0) + 1
process.stderr.write(`done (${all.length} unique pkgs, ${Object.keys(byLicense).length} distinct licenses)\n`)

writeFileSync('reports/security/licenses.json', JSON.stringify({
  total: all.length,
  byLicense,
  packages: all,
}, null, 2))

console.log('security:', { audit: meta, licenses: { total: all.length, distinct: Object.keys(byLicense).length } })
