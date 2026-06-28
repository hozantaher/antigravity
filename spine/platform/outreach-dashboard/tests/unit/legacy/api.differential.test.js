// Differential tests — API list endpoints vs raw SQL count + ID overlap.
// Catches drift where the handler builds a DIFFERENT WHERE than expected
// (e.g. silently joins, dedupes, filters by tenant, etc.). Snapshot tests
// pin shape; this pins SET MEMBERSHIP. If API returns ids ⊄ DB ids, the
// API is making rows up — alarm. If DB has rows API doesn't, the API is
// dropping rows silently — also alarm (within page-size constraint).
//
// Each endpoint declares the equivalent SQL. Equivalence is intentionally
// brittle — if you change the endpoint's filter, update the SQL here, OR
// the test catches the deviation. That's the point.
//
// Backend must be running on :3001 with DATABASE_URL pointing at same DB.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'
import pg from 'pg'
import { readFileSync } from 'fs'

const BASE = 'http://localhost:3001'

beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

let DSN = process.env.DATABASE_URL
if (!DSN) {
  try {
    const env = readFileSync(`${process.cwd()}/.env`, 'utf8')
    DSN = env.split('\n').find(l => l.startsWith('DATABASE_URL='))?.slice(13).trim()
  } catch {}
}
const pool = DSN ? new pg.Pool({ connectionString: DSN, max: 2 }) : null

afterAll(async () => { if (pool) await pool.end() })

// Endpoint → equivalent SQL: count + id-projection.
// id-key = the field the API exposes for identity (e.g. ico for companies).
const PROBES = [
  {
    name: 'companies',
    api: '/api/companies?limit=50&offset=0',
    countSql: `SELECT COUNT(*)::int AS n FROM companies
               WHERE datum_zaniku IS NULL AND v_likvidaci=false AND v_insolvenci=false`,
    idsSql: `SELECT ico FROM companies
             WHERE datum_zaniku IS NULL AND v_likvidaci=false AND v_insolvenci=false`,
    idKey: 'ico',
    paged: true,
    pageLimit: 50,
  },
  {
    name: 'campaigns',
    api: '/api/campaigns',
    countSql: `SELECT COUNT(*)::int AS n FROM campaigns`,
    idsSql: `SELECT id FROM campaigns`,
    idKey: 'id',
  },
  {
    name: 'templates',
    api: '/api/templates',
    countSql: `SELECT COUNT(*)::int AS n FROM email_templates`,
    idsSql: `SELECT id FROM email_templates`,
    idKey: 'id',
  },
  {
    name: 'mailboxes',
    api: '/api/mailboxes',
    countSql: `SELECT COUNT(*)::int AS n FROM outreach_mailboxes`,
    idsSql: `SELECT id FROM outreach_mailboxes`,
    idKey: 'id',
  },
]

describe.skipIf(!pool)('API ↔ SQL differential', () => {
  for (const p of PROBES) {
    describe(p.name, () => {
      it('count matches (API total/length vs raw SQL count)', async () => {
        const r = await fetch(BASE + p.api)
        expect(r.status).toBe(200)
        const body = await r.json()
        const apiRows = Array.isArray(body) ? body : (body.rows || [])
        const apiTotal = Array.isArray(body) ? body.length : (body.total ?? body.rows?.length ?? 0)
        const { rows: [{ n }] } = await pool.query(p.countSql)

        if (p.paged) {
          // paged endpoint: total field should match SQL count exactly
          expect(apiTotal).toBe(n)
          // page itself should not exceed pageLimit
          expect(apiRows.length).toBeLessThanOrEqual(p.pageLimit)
        } else {
          // unpaged endpoint: returned rows = all rows
          expect(apiRows.length).toBe(n)
        }
      })

      it('returned ids ⊆ DB ids (no fabricated rows)', async () => {
        const r = await fetch(BASE + p.api)
        const body = await r.json()
        const apiRows = Array.isArray(body) ? body : (body.rows || [])
        if (apiRows.length === 0) return  // empty page can't fabricate

        const apiIds = apiRows.map(x => String(x[p.idKey]))
        // Probe DB only for API's ids — companies table has millions of rows.
        // Cast both sides to text so int/uuid/text id columns all work.
        const { rows: dbRows } = await pool.query(
          `SELECT ${p.idKey}::text AS ${p.idKey} FROM ${p.idsSql.match(/FROM (\w+)/)[1]} WHERE ${p.idKey}::text = ANY($1::text[])`,
          [apiIds]
        )
        const dbIds = new Set(dbRows.map(x => String(x[p.idKey])))
        const fabricated = apiIds.filter(id => !dbIds.has(id))
        expect(fabricated, `API ids not in DB: ${fabricated.slice(0, 5).join(', ')}`).toEqual([])
      }, 15000)

      // For unpaged endpoints we can also check the reverse: every DB id
      // must appear in the API response. Skipped for paged endpoints —
      // a single page can legitimately omit rows.
      if (!p.paged) {
        it('DB ids ⊆ API ids (no silent row drops)', async () => {
          const r = await fetch(BASE + p.api)
          const body = await r.json()
          const apiRows = Array.isArray(body) ? body : (body.rows || [])
          const apiIds = new Set(apiRows.map(x => String(x[p.idKey])))
          const { rows: dbRows } = await pool.query(p.idsSql)
          const dbIds = dbRows.map(x => String(x[p.idKey]))

          const dropped = dbIds.filter(id => !apiIds.has(id))
          expect(dropped, `DB rows missing from API: ${dropped.slice(0, 5).join(', ')}`).toEqual([])
        })
      }
    })
  }
})
