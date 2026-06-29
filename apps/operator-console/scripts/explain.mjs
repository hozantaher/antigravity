#!/usr/bin/env node
// EXPLAIN ANALYZE snapshot for hot read queries.
// Goal: pin query plans + index usage; CI alerts on plan regressions
// (e.g. silently flipping from index scan to seq scan).
//
// Run: node scripts/explain.mjs
// Writes: reports/explain/{plans.json, BASELINE.md}

import pg from 'pg'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

try {
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').forEach(l => { const [k,...v]=l.split('='); if(k&&v.length) process.env[k.trim()]=v.join('=').trim() })
} catch {}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

// Hot queries — kept verbatim from server.js so plans match production.
const QUERIES = [
  {
    name: 'companies-list-default',
    note: 'Default sort by best_targeting_score DESC, no filters',
    sql: `SELECT ico,name,category_path,address_locality,best_targeting_score,email
          FROM companies
          WHERE datum_zaniku IS NULL AND v_likvidaci=false AND v_insolvenci=false
          ORDER BY best_targeting_score DESC NULLS LAST, ico ASC LIMIT $1 OFFSET $2`,
    params: [20, 0],
  },
  {
    name: 'companies-list-count',
    note: 'COUNT(*) for pagination — runs alongside list query',
    sql: `SELECT COUNT(*)::int AS total FROM companies
          WHERE datum_zaniku IS NULL AND v_likvidaci=false AND v_insolvenci=false`,
    params: [],
  },
  {
    name: 'companies-search-name',
    note: 'ILIKE search on name — typically no trigram index',
    sql: `SELECT ico,name,category_path FROM companies
          WHERE datum_zaniku IS NULL AND v_likvidaci=false AND v_insolvenci=false
            AND (name ILIKE $1 OR ico ILIKE $2)
          ORDER BY best_targeting_score DESC NULLS LAST, ico ASC LIMIT $3 OFFSET $4`,
    params: ['%stav%', '%stav%', 20, 0],
  },
  {
    name: 'companies-by-ico',
    note: 'Single-row lookup by primary key',
    sql: `SELECT ico, name FROM companies WHERE ico = $1`,
    params: ['00000000'],
  },
  {
    name: 'campaigns-list',
    note: 'Aggregate of send_events grouped per campaign',
    sql: `SELECT c.id, c.name, c.status,
                 COALESCE(jsonb_object_agg(se.status, se.cnt) FILTER (WHERE se.status IS NOT NULL), '{}') AS stats
          FROM campaigns c
          LEFT JOIN (
            SELECT campaign_id, status, COUNT(*)::int AS cnt
            FROM send_events GROUP BY campaign_id, status
          ) se ON se.campaign_id = c.id
          GROUP BY c.id ORDER BY c.created_at DESC`,
    params: [],
  },
  {
    name: 'replies-list',
    note: 'Reply inbox with campaign + contact joins',
    sql: `SELECT r.id, r.subject, r.received_at, r.handled,
                 c.name AS campaign_name,
                 TRIM(COALESCE(ct.first_name,'') || ' ' || COALESCE(ct.last_name,'')) AS contact_name
          FROM reply_inbox r
          LEFT JOIN campaigns c ON c.id = r.campaign_id
          LEFT JOIN contacts ct ON ct.id = r.contact_id
          ORDER BY r.received_at DESC LIMIT $1 OFFSET $2`,
    params: [20, 0],
  },
  {
    name: 'mailboxes-list',
    note: 'All mailboxes — typically small table',
    sql: `SELECT id, from_address, smtp_host, status FROM outreach_mailboxes ORDER BY created_at DESC`,
    params: [],
  },
]

// Heuristics for plan health.
function analyze(plan) {
  const flat = JSON.stringify(plan)
  const flags = []
  // Sequential scan on a large table is usually a smell.
  const seqScans = (flat.match(/"Node Type":"Seq Scan"/g) || []).length
  if (seqScans > 0) flags.push(`SEQ_SCAN×${seqScans}`)
  // Sort spilled to disk → memory pressure.
  if (/"Sort Method":"external/.test(flat)) flags.push('EXTERNAL_SORT')
  // Hash batches > 1 = hash join spilled.
  const hashSpills = flat.match(/"Hash Batches":(\d+)/g)
  if (hashSpills?.some(m => Number(m.match(/\d+/)[0]) > 1)) flags.push('HASH_SPILL')
  // Filter dropping > 90% of rows → missing index.
  const lossyFilters = []
  function walk(node) {
    if (!node) return
    if (node['Rows Removed by Filter'] && node['Actual Rows']) {
      const removed = node['Rows Removed by Filter']
      const kept = node['Actual Rows']
      if (removed > 1000 && removed / (removed + kept) > 0.9) {
        lossyFilters.push({ node: node['Node Type'], removed, kept })
      }
    }
    if (Array.isArray(node.Plans)) node.Plans.forEach(walk)
  }
  walk(plan.Plan)
  if (lossyFilters.length) flags.push(`LOSSY_FILTER×${lossyFilters.length}`)
  return { flags, lossyFilters, seqScans }
}

async function explainOne(q) {
  const sql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`
  process.stdout.write(`→ ${q.name.padEnd(28)} `)
  try {
    const { rows } = await pool.query(sql, q.params)
    const plan = rows[0]['QUERY PLAN'][0]
    const a = analyze(plan)
    const exec = plan['Execution Time']
    const planning = plan['Planning Time']
    process.stdout.write(`exec=${exec.toFixed(1)}ms plan=${planning.toFixed(1)}ms flags=[${a.flags.join(',') || 'ok'}]\n`)
    return {
      name: q.name,
      note: q.note,
      sql: q.sql.replace(/\s+/g, ' ').trim(),
      execution_ms: exec,
      planning_ms: planning,
      flags: a.flags,
      lossy_filters: a.lossyFilters,
      seq_scans: a.seqScans,
      plan,
    }
  } catch (e) {
    process.stdout.write(`ERROR: ${e.message}\n`)
    return { name: q.name, error: e.message, sql: q.sql.replace(/\s+/g, ' ').trim() }
  }
}

function writeReport(results) {
  const dir = 'reports/explain'
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plans.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    results,
  }, null, 2))

  const md = [
    '# SQL EXPLAIN Baseline',
    '',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    `**Tool:** \`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\``,
    `**Goal:** detect plan regressions (seq scans, lossy filters, sort spills) on hot read paths.`,
    '',
    '## Per-query summary',
    '',
    '| Query | Exec (ms) | Plan (ms) | Flags |',
    '|-------|----------:|----------:|-------|',
    ...results.map(r => r.error
      ? `| \`${r.name}\` | ERROR | ERROR | ${r.error} |`
      : `| \`${r.name}\` | ${r.execution_ms.toFixed(1)} | ${r.planning_ms.toFixed(1)} | ${r.flags.join(', ') || 'ok'} |`),
    '',
    '## Findings',
    '',
    ...results.flatMap(r => {
      if (r.error) return [`### ${r.name}`, `- ERROR: ${r.error}`, '']
      const out = [`### ${r.name}`, `> ${r.note}`, '']
      if (r.flags.length === 0) {
        out.push('_Plan looks healthy._', '')
        return out
      }
      out.push('**Flags:** ' + r.flags.join(', '))
      if (r.lossy_filters.length) {
        out.push('', '**Lossy filters (likely missing index):**')
        r.lossy_filters.forEach(lf => out.push(`- ${lf.node}: removed ${lf.removed.toLocaleString()} rows, kept ${lf.kept.toLocaleString()}`))
      }
      out.push('')
      return out
    }),
    '## Index recommendations',
    '',
    'Based on flags above:',
    '',
    '- **`companies` ILIKE search**: add `pg_trgm` GIN index on `(name)` and `(ico)`.',
    '  ```sql',
    '  CREATE EXTENSION IF NOT EXISTS pg_trgm;',
    '  CREATE INDEX CONCURRENTLY companies_name_trgm ON companies USING gin (name gin_trgm_ops);',
    '  CREATE INDEX CONCURRENTLY companies_ico_trgm  ON companies USING gin (ico  gin_trgm_ops);',
    '  ```',
    '- **`companies` ORDER BY best_targeting_score**: partial index for active rows:',
    '  ```sql',
    '  CREATE INDEX CONCURRENTLY companies_active_score',
    '    ON companies (best_targeting_score DESC NULLS LAST, ico)',
    '    WHERE datum_zaniku IS NULL AND v_likvidaci=false AND v_insolvenci=false;',
    '  ```',
    '- **`reply_inbox` ORDER BY received_at**: `CREATE INDEX CONCURRENTLY reply_inbox_received_idx ON reply_inbox (received_at DESC);`',
    '- **`send_events` GROUP BY (campaign_id, status)**: `CREATE INDEX CONCURRENTLY send_events_campaign_status ON send_events (campaign_id, status);`',
    '',
    'Re-run `node scripts/explain.mjs` after each index addition; the SEQ_SCAN flag should disappear and exec time should drop.',
    '',
    '## How to re-run',
    '',
    '```sh',
    'node scripts/explain.mjs',
    '```',
    '',
    'Raw plans: `reports/explain/plans.json`',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'BASELINE.md'), md)
  console.log(`\nWrote ${dir}/plans.json + ${dir}/BASELINE.md`)
}

async function main() {
  console.log(`SQL EXPLAIN snapshot → ${process.env.DATABASE_URL?.split('@')[1] || 'db'}\n`)
  const results = []
  for (const q of QUERIES) {
    results.push(await explainOne(q))
  }
  writeReport(results)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(2) })
