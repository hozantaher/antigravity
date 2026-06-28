// Idempotency probes — POST/PUT/PATCH with Idempotency-Key header must
// produce one row + identical body on replay. Server middleware caches
// per (method, path, key) for 10min.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'
import pg from 'pg'
import { readFileSync } from 'fs'

const BASE = 'http://localhost:3001'
const TAG = 'idem_probe'

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

afterAll(async () => {
  if (!pool) return
  await pool.query(`DELETE FROM email_templates WHERE name LIKE '${TAG}%'`).catch(() => {})
  await pool.query(`DELETE FROM campaigns WHERE name LIKE '${TAG}%'`).catch(() => {})
  await pool.end()
})

const post = (path, body, key) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
})

describe.skipIf(!DSN)('Idempotency-Key — replay returns cached body, no extra row', () => {
  it('POST /api/templates: same key → single row + identical body', async () => {
    const key = `t-${Date.now()}-${Math.random()}`
    const body = { name: `${TAG}_${Date.now()}`, subject: 's', body: 'b' }
    const a = await post('/api/templates', body, key).then(r => r.json())
    const b = await post('/api/templates', body, key)
    const bJson = await b.json()

    expect(a.id).toBe(bJson.id)
    expect(b.headers.get('Idempotent-Replay')).toBe('1')

    const { rows } = await pool.query('SELECT count(*)::int FROM email_templates WHERE name=$1', [body.name])
    expect(rows[0].count).toBe(1)
  })

  it('POST /api/campaigns: same key → single row', async () => {
    const key = `c-${Date.now()}-${Math.random()}`
    const body = { name: `${TAG}_camp_${Date.now()}` }
    const a = await post('/api/campaigns', body, key).then(r => r.json())
    const b = await post('/api/campaigns', body, key).then(r => r.json())

    expect(a.id).toBe(b.id)
    const { rows } = await pool.query('SELECT count(*)::int FROM campaigns WHERE name=$1', [body.name])
    expect(rows[0].count).toBe(1)
  })

  it('different keys → independent writes', async () => {
    // Keys must be unique per test run — middleware caches (method,path,key)
    // for 10min so static 'k-A'/'k-B' would replay a prior run's response.
    const ts = Date.now()
    const baseName = `${TAG}_diff_${ts}`
    await post('/api/templates', { name: `${baseName}_a`, subject: '', body: '' }, `kA-${ts}`)
    await post('/api/templates', { name: `${baseName}_b`, subject: '', body: '' }, `kB-${ts}`)
    const { rows } = await pool.query('SELECT count(*)::int FROM email_templates WHERE name LIKE $1', [`${baseName}%`])
    expect(rows[0].count).toBe(2)
  })

  it('no Idempotency-Key → no replay (creates 2 rows)', async () => {
    const body = { name: `${TAG}_nokey_${Date.now()}`, subject: '', body: '' }
    await post('/api/templates', body)
    await post('/api/templates', body)
    const { rows } = await pool.query('SELECT count(*)::int FROM email_templates WHERE name=$1', [body.name])
    expect(rows[0].count).toBe(2)
  })

  it('GET ignores Idempotency-Key (read-only safe)', async () => {
    const r1 = await fetch(`${BASE}/api/companies/stats`, { headers: { 'Idempotency-Key': 'g1' } })
    expect(r1.headers.get('Idempotent-Replay')).toBeNull()
  })
})
