#!/usr/bin/env node
// CI gate that asserts the Sprint 2 companies filter queries stay indexable.
// Fails (exit 2) when Postgres would resort to a Seq Scan on `companies`
// or drops >90% of rows via a post-fetch Filter — both signals that an
// index is missing or unusable.
//
// Run: node scripts/explain-gate.mjs
// CI wiring: add to the pre-merge pipeline after apply-migrations. The
// baseline snapshot lives in `reports/explain/BASELINE.md` (scripts/explain.mjs).

import pg from 'pg'
import { readFileSync } from 'fs'

try {
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').forEach(l => { const [k,...v]=l.split('='); if(k&&v.length) process.env[k.trim()]=v.join('=').trim() })
} catch {}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set — skipping gate')
  process.exit(0)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

// Each case mirrors a real /api/companies call with the new filter knobs.
// Keep SQL verbatim with server.js so the plan the gate sees matches prod.
const BASE_WHERE = `datum_zaniku IS NULL AND v_likvidaci=false AND v_insolvenci=false`
const CASES = [
  {
    name: 'score-range',
    sql: `SELECT ico FROM companies
          WHERE ${BASE_WHERE}
            AND composite_score >= $1 AND composite_score <= $2
          ORDER BY composite_score DESC NULLS LAST, id ASC LIMIT $3`,
    params: [40, 90, 50],
  },
  {
    name: 'region-multi',
    sql: `SELECT ico FROM companies
          WHERE ${BASE_WHERE}
            AND region_normalized = ANY($1::text[])
          ORDER BY composite_score DESC NULLS LAST, id ASC LIMIT $2`,
    params: [['Hlavní město Praha', 'Jihomoravský kraj'], 50],
  },
  {
    name: 'sector-multi',
    sql: `SELECT ico FROM companies
          WHERE ${BASE_WHERE}
            AND sector_primary = ANY($1::text[])
          ORDER BY composite_score DESC NULLS LAST, id ASC LIMIT $2`,
    params: [['Stavebnictví', 'Doprava'], 50],
  },
  {
    name: 'region-autocomplete-prefix',
    sql: `SELECT region_normalized, COUNT(*)::int AS n FROM companies
          WHERE ${BASE_WHERE}
            AND region_normalized IS NOT NULL
            AND lower(region_normalized) LIKE lower($1)
          GROUP BY region_normalized
          ORDER BY n DESC LIMIT 20`,
    params: ['Pr%'],
  },
  {
    name: 'sector-autocomplete-prefix',
    sql: `SELECT sector_primary, COUNT(*)::int AS n FROM companies
          WHERE ${BASE_WHERE}
            AND sector_primary IS NOT NULL
            AND lower(sector_primary) LIKE lower($1)
          GROUP BY sector_primary
          ORDER BY n DESC LIMIT 20`,
    params: ['St%'],
  },
  {
    name: 'combined-score-region-sector',
    sql: `SELECT ico FROM companies
          WHERE ${BASE_WHERE}
            AND composite_score >= $1
            AND region_normalized = ANY($2::text[])
            AND sector_primary = ANY($3::text[])
          ORDER BY composite_score DESC NULLS LAST, id ASC LIMIT $4`,
    params: [60, ['Hlavní město Praha'], ['Stavebnictví'], 50],
  },
  {
    name: 'never-contacted',
    sql: `SELECT ico FROM companies
          WHERE ${BASE_WHERE}
            AND last_contacted IS NULL
          ORDER BY composite_score DESC NULLS LAST, id ASC LIMIT $1`,
    params: [50],
  },
  {
    name: 'last-contacted-since',
    sql: `SELECT ico FROM companies
          WHERE ${BASE_WHERE}
            AND last_contacted >= $1
          ORDER BY composite_score DESC NULLS LAST, id ASC LIMIT $2`,
    params: ['2026-01-01', 50],
  },
]

function seqScanOnCompanies(plan) {
  const flat = JSON.stringify(plan)
  return /"Node Type":"Seq Scan"[^}]*"Relation Name":"companies"/.test(flat)
}

function lossyFilter(plan) {
  let worst = null
  ;(function walk(node) {
    if (!node) return
    const removed = node['Rows Removed by Filter'] ?? 0
    const kept = node['Actual Rows'] ?? 0
    const total = removed + kept
    if (removed > 1000 && total > 0 && removed / total > 0.9) {
      const score = removed
      if (!worst || score > worst.removed) worst = { node: node['Node Type'], removed, kept }
    }
    if (Array.isArray(node.Plans)) node.Plans.forEach(walk)
  })(plan.Plan)
  return worst
}

async function run() {
  const violations = []
  for (const c of CASES) {
    try {
      const sql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${c.sql}`
      const { rows } = await pool.query(sql, c.params)
      const plan = rows[0]['QUERY PLAN'][0]
      const exec = plan['Execution Time'].toFixed(1)
      const seq = seqScanOnCompanies(plan)
      const lossy = lossyFilter(plan)
      const flags = [seq && 'SEQ_SCAN', lossy && `LOSSY(${lossy.removed})`].filter(Boolean)
      console.log(`→ ${c.name.padEnd(32)} ${exec.padStart(7)}ms  ${flags.join(',') || 'ok'}`)
      if (seq) violations.push({ case: c.name, kind: 'seq_scan' })
      if (lossy) violations.push({ case: c.name, kind: 'lossy_filter', detail: lossy })
    } catch (e) {
      console.log(`→ ${c.name.padEnd(32)} ERROR: ${e.message}`)
      violations.push({ case: c.name, kind: 'error', detail: e.message })
    }
  }
  await pool.end()

  if (violations.length) {
    console.error(`\n✗ EXPLAIN gate failed — ${violations.length} violation(s):`)
    for (const v of violations) console.error('  -', JSON.stringify(v))
    console.error('\nFix: add/adjust indexes in internal/db/migrations and re-apply.')
    process.exit(2)
  }
  console.log('\n✓ EXPLAIN gate passed')
}

run().catch(e => { console.error(e); process.exit(2) })
