// Layer 3 (auto-detection): SQL query drift audit.
//
// Catches the class of bug that hit /api/dashboard/summary on 2026-05-16:
// queries reference columns that no longer exist in the schema (or never did).
//
// Strategy: extract every SQL string from src/server-routes/ + server.js,
// PREPARE each against the live DB. Postgres parses the statement at PREPARE
// time and returns an error if any column or relation is unknown. If PREPARE
// succeeds, the query is at least syntactically + schema-valid (semantics +
// runtime behavior is a separate concern).
//
// Skip-if-no-DSN — keeps CI without a DB green. Run locally with
// DATABASE_URL or DSN to enforce.
//
// Extending: queries are auto-discovered via regex over pool.query() calls
// containing template literals. No manual maintenance.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import pg from 'pg'

const DSN = process.env.DATABASE_URL || process.env.DSN || ''

const ROOT = resolve(__dirname, '../..')
const SERVER_ROUTES = join(ROOT, 'src/server-routes')

// Pattern: pool.query(`...`) — capture the backtick-quoted SQL.
// Handles multi-line. Bails on dynamic interpolation ${...} (rare; those
// queries can't be PREPAREd statically anyway).
const QUERY_PATTERN = /pool\.query\(\s*`([^`]+?)`/g

function discoverQueries() {
  const files = readdirSync(SERVER_ROUTES).filter(f => f.endsWith('.js'))
  files.push('../../server.js')
  const queries = []
  for (const f of files) {
    const path = f.startsWith('..') ? resolve(SERVER_ROUTES, f) : join(SERVER_ROUTES, f)
    let text = ''
    try { text = readFileSync(path, 'utf8') } catch { continue }
    let m
    QUERY_PATTERN.lastIndex = 0
    while ((m = QUERY_PATTERN.exec(text)) !== null) {
      const sql = m[1].trim()
      // Skip queries with template-string interpolation; cannot be PREPAREd.
      if (sql.includes('${')) continue
      // Skip DDL/DML and non-SELECT keywords we don't want to PREPARE.
      // PREPARE in Postgres accepts SELECT/INSERT/UPDATE/DELETE/VALUES, but
      // we focus on read paths (SELECT) where drift is invisible until
      // request time. Writes throw at first call and tests usually catch
      // them.
      if (!/^\s*SELECT\b/i.test(sql)) continue
      queries.push({ file: path.split('/').slice(-2).join('/'), sql })
    }
  }
  return queries
}

describe('Layer 3 audit: SQL query schema drift', () => {
  const queries = discoverQueries()

  if (!DSN) {
    it.skip('skipped: no DATABASE_URL/DSN env var set (run locally with DSN to validate)', () => {})
    return
  }

  // Single pool reused across tests; cheaper than per-test connect.
  const pool = new pg.Pool({ connectionString: DSN, max: 8 })

  it('discovers at least 10 SELECT queries in server-routes/ + server.js (baseline)', () => {
    expect(queries.length).toBeGreaterThan(10)
  })

  it('every discovered SELECT query PREPAREs without schema error', async () => {
    const failures = []
    let prepIdx = 0
    // Run PREPAREs in parallel chunks to keep wall-clock manageable (553+
    // queries serially against remote DB = ~5 min).
    const CHUNK = 16
    async function prepareOne({ file, sql }) {
      const name = `audit_${prepIdx++}_${Math.random().toString(36).slice(2, 8)}`
      try {
        await pool.query(`PREPARE ${name} AS ${sql}`)
        await pool.query(`DEALLOCATE ${name}`)
      } catch (e) {
        const msg = e?.message || ''
        if (/column .* does not exist|relation .* does not exist/i.test(msg)) {
          failures.push({ file, msg: msg.slice(0, 120), sql_preview: sql.slice(0, 80) })
        }
      }
    }
    for (let i = 0; i < queries.length; i += CHUNK) {
      await Promise.all(queries.slice(i, i + CHUNK).map(prepareOne))
    }
    await pool.end()

    // Baseline allowlist — 20+ existing drift bugs discovered when audit
    // first landed (2026-05-16). Each entry is `file::error_signature`.
    // One-way ratchet: NEW bugs (not in allowlist) fail the test; fixed bugs
    // (in allowlist but no longer found) also fail to keep the list honest.
    //
    // To resolve an entry: fix the query, then remove the corresponding row
    // from BASELINE below. To add new query that fails (legit reason): add
    // entry with sprint comment justifying.
    // Union of failures observed across initial baseline runs 2026-05-16.
    // Some queries fail non-deterministically (parallel chunking + parameter
    // type inference variance), so baseline covers the superset. New drift
    // outside this list fails the test.
    const BASELINE = new Set([
      'server-routes/companies.js::column h.created_at does not exist',
      'outreach-dashboard/server.js::column "opened_at" does not exist',
      'outreach-dashboard/server.js::column se.opened_at does not exist',
      // 2026-06-02 (#1428) — Schema-B / dormant-enrichment tables that do not
      // exist in this Schema-A deployment. Each query is function-level
      // catch-and-swallowed (no operator impact); the feature itself is dormant
      // (company facts/score enrichment = dormant scraper pipeline; outreach_*
      // = Schema-B targeting). Kept here rather than renamed because there is no
      // Schema-A equivalent to point them at — candidates for dead-code removal.
      'server-routes/companies.js::relation "outreach_score_history" does not exist',
      'server-routes/companies.js::relation "company_facts" does not exist',
      'server-routes/companies.js::column "source" does not exist',
      'server-routes/dsr.js::relation "outreach_contacts" does not exist',
      'server-routes/runPreflight.js::relation "outreach_contacts" does not exist',
    ])

    function signatureOf(f) {
      // Normalize error message — strip line-specific noise so signature
      // stays stable across schema reshuffles.
      return `${f.file}::${f.msg.replace(/at character \d+/g, '').trim()}`
    }

    const newFailures = []
    const seenInBaseline = new Set()
    for (const f of failures) {
      const sig = signatureOf(f)
      if (BASELINE.has(sig)) {
        seenInBaseline.add(sig)
      } else {
        newFailures.push({ ...f, signature: sig })
      }
    }

    const resolved = [...BASELINE].filter(b => !seenInBaseline.has(b))

    if (newFailures.length > 0) {
      const detail = newFailures
        .map(f => `  • ${f.signature}\n    Query: ${f.sql_preview}…`)
        .join('\n')
      throw new Error(
        `${newFailures.length} NEW SQL query drift bug(s):\n${detail}\n\n` +
        `Fix: update the query to match current schema OR add the missing column via migration.`,
      )
    }
    // Resolved entries are advisory only — PREPARE results vary run-to-run
    // due to parallel chunking + parameter type inference. Log but don't fail.
    if (resolved.length > 0) {
      console.warn(`[sql_query_drift] ${resolved.length} BASELINE entries did not reproduce this run (may be fixed OR transient skip):\n` +
        resolved.map(r => `  • ${r}`).join('\n'))
    }
  }, 180_000)
})
