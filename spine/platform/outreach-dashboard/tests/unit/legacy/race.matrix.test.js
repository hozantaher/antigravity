// Race-condition matrix — concurrent operations against the live API.
// Documents which writes are idempotent vs. which silently dup. If a test
// fails, either: (a) handler dropped a constraint/lock, or (b) baseline
// assumption changed → update test + open issue.
//
// Each scenario:
//   1. fan-out N parallel writes
//   2. assert post-condition (row count, conflict status, etc.)
//   3. cleanup probe rows (race_probe_* prefix)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'
import pg from 'pg'
import { readFileSync } from 'fs'

const BASE = 'http://localhost:3001'
const PROBE = 'race_probe'

beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

let DSN = process.env.DATABASE_URL
if (!DSN) {
  try {
    const env = readFileSync(`${process.cwd()}/.env`, 'utf8')
    DSN = env.split('\n').find(l => l.startsWith('DATABASE_URL='))?.slice(13).trim()
  } catch {}
}
const pool = DSN ? new pg.Pool({ connectionString: DSN, max: 4 }) : null

afterAll(async () => {
  if (!pool) return
  await pool.query(`DELETE FROM email_templates WHERE name LIKE '${PROBE}%'`).catch(() => {})
  await pool.query(`DELETE FROM campaigns WHERE name LIKE '${PROBE}%'`).catch(() => {})
  await pool.end()
})

async function fan(n, fn) {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)))
}

describe.skipIf(!DSN)('Race matrix — concurrent writes', () => {
  it('campaigns: concurrent POST same name — DOCUMENTS dup behavior', async () => {
    const name = `${PROBE}_camp_${Date.now()}`
    const results = await fan(5, () => fetch(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(r => r.json()))

    const ids = results.map(r => r.id).filter(Boolean)
    const { rows } = await pool.query('SELECT count(*)::int FROM campaigns WHERE name=$1', [name])
    // Currently no UNIQUE on campaigns.name → 5 dups land. If migration adds
    // UNIQUE, expectation flips to ≤1 + 4×500. Update then.
    expect(rows[0].count).toBeGreaterThanOrEqual(1)
    expect(rows[0].count).toBeLessThanOrEqual(5)
    expect(ids.length).toBeLessThanOrEqual(5)
  })

  it('templates: concurrent PUT same id — last-write-wins, no torn state', async () => {
    const create = await fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${PROBE}_t_${Date.now()}`, subject: 's', body: 'b' }),
    }).then(r => r.json())
    expect(create.id).toBeDefined()

    await fan(8, (i) => fetch(`${BASE}/api/templates/${create.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: create.name, subject: `s${i}`, body: `b${i}` }),
    }))

    const { rows } = await pool.query('SELECT subject, body FROM email_templates WHERE id=$1', [create.id])
    expect(rows.length).toBe(1)
    // Last write wins → subject + body must be one of the writes (sN/bN), never mixed
    const sIdx = rows[0].subject.replace('s', '')
    const bIdx = rows[0].body.replace('b', '')
    expect(sIdx).toBe(bIdx)  // no torn write between subject and body
  })

  it('templates: concurrent POST different names — all rows persisted', async () => {
    const tag = `${PROBE}_pc_${Date.now()}`
    await fan(6, (i) => fetch(`${BASE}/api/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${tag}_${i}`, subject: 's', body: 'b' }),
    }))
    const { rows } = await pool.query('SELECT count(*)::int FROM email_templates WHERE name LIKE $1', [`${tag}%`])
    expect(rows[0].count).toBe(6)
  })

  it('GET burst: concurrent reads return consistent shape', async () => {
    const responses = await fan(20, () => fetch(`${BASE}/api/companies/stats`).then(r => r.json()))
    const totals = new Set(responses.map(r => r.total))
    expect(totals.size).toBeLessThanOrEqual(2)  // may flicker by 1 due to in-flight inserts; never wildly different
    for (const r of responses) expect(typeof r.total).toBe('number')
  })
})
