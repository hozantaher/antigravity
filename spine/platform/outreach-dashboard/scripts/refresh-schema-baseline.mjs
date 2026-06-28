#!/usr/bin/env node
// Refresh schema-manifest.json baseline from live Go /schema endpoint.
// Run: node scripts/refresh-schema-baseline.mjs [--url=...]
//
// Updates the baseline that /api/__schema-check uses for drift detection.
// PR-only commits, with reason in commit message (e.g. "added column X for feature Y").

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)=(.*)$/)
  if (m) acc[m[1]] = m[2]
  return acc
}, {})

const url = args.url || process.env.GO_SERVER_URL || 'http://localhost:8080'
const baselinePath = resolve(import.meta.dirname, '../schema-manifest.json')

console.log(`[refresh-schema-baseline] Fetching ${url}/schema …`)

try {
  const response = await fetch(`${url}/schema`)
  if (!response.ok) {
    console.error(`[refresh-schema-baseline] Go /schema returned ${response.status}`)
    process.exit(1)
  }
  const manifest = await response.json()

  if (!manifest.tables || !manifest.manifest_hash) {
    console.error('[refresh-schema-baseline] Malformed response (missing tables or manifest_hash)')
    console.error(JSON.stringify(manifest, null, 2).slice(0, 500))
    process.exit(2)
  }

  // Add baseline metadata
  const enriched = {
    version: manifest.version || '1',
    _comment: 'Frozen baseline. Regenerate via: node scripts/refresh-schema-baseline.mjs',
    _baseline_generated_at: new Date().toISOString(),
    _baseline_generator: 'scripts/refresh-schema-baseline.mjs',
    manifest_hash: manifest.manifest_hash,
    tables: manifest.tables,
  }

  // Compare to existing baseline
  let prevHash = null
  try {
    const prev = JSON.parse(readFileSync(baselinePath, 'utf8'))
    prevHash = prev.manifest_hash
  } catch {
    /* no prior baseline */
  }

  if (prevHash === manifest.manifest_hash) {
    console.log(`[refresh-schema-baseline] No change: ${manifest.manifest_hash}`)
    process.exit(0)
  }

  writeFileSync(baselinePath, JSON.stringify(enriched, null, 2) + '\n')
  console.log(`[refresh-schema-baseline] ✓ Updated baseline:`)
  console.log(`  Previous: ${prevHash || '(none)'}`)
  console.log(`  Current:  ${manifest.manifest_hash}`)
  console.log(`  Tables:   ${Object.keys(enriched.tables).length}`)
  console.log(`\nNext step: review diff + commit with explanation.`)
} catch (e) {
  console.error(`[refresh-schema-baseline] Error: ${e.message}`)
  process.exit(3)
}
