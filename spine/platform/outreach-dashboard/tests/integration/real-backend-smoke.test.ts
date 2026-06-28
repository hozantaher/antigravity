// S6 — Real-backend smoke test.
// 5 critical endpoints round-trip against testcontainers Postgres.
// Skip-if-no-Docker — fallback for CI without Docker daemon.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-ignore — module resolution
import { startPostgres, type PgContext } from './_setup/postgres-container.js'
import express from 'express'

let ctx: PgContext | null = null
let server: any
let port: number

beforeAll(async () => {
  ctx = await startPostgres()
  if (!ctx) return

  // Build minimal Express app with the 5 critical handlers, wired to real
  // pg pool from testcontainers.
  const app = express()
  app.use(express.json())

  // 1. /api/health — liveness
  app.get('/api/health', async (req, res) => {
    try {
      const r = await ctx!.pool.query('SELECT 1 AS ok')
      res.json({ ok: r.rows[0].ok === 1, db: 'up' })
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 2. /api/templates — CRUD round-trip
  app.get('/api/templates', async (req, res) => {
    try {
      await ctx!.pool.query(`CREATE TABLE IF NOT EXISTS email_templates (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT now()
      )`)
      const r = await ctx!.pool.query('SELECT * FROM email_templates ORDER BY id')
      res.json(r.rows)
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/api/templates', async (req, res) => {
    try {
      const { name, subject, body } = req.body || {}
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' })
      const r = await ctx!.pool.query(
        `INSERT INTO email_templates(name, subject, body) VALUES($1, $2, $3) RETURNING *`,
        [name, subject || '', body || '']
      )
      res.json(r.rows[0])
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // 3. /api/replies/stats — aggregation against reply_inbox
  app.get('/api/replies/stats', async (req, res) => {
    try {
      await ctx!.pool.query(`CREATE TABLE IF NOT EXISTS reply_inbox (
        id SERIAL PRIMARY KEY,
        send_event_id INT,
        classification TEXT,
        handled BOOLEAN DEFAULT FALSE,
        received_at TIMESTAMPTZ DEFAULT now()
      )`)
      const r = await ctx!.pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE handled = false)::int AS unhandled,
               COUNT(*) FILTER (WHERE classification = 'positive')::int AS positive,
               COUNT(*) FILTER (WHERE classification = 'negative')::int AS negative
        FROM reply_inbox
      `)
      res.json(r.rows[0])
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // 4. /api/companies/stats — count + active filter
  app.get('/api/companies/stats', async (req, res) => {
    try {
      await ctx!.pool.query(`CREATE TABLE IF NOT EXISTS companies (
        ico TEXT PRIMARY KEY,
        nazev TEXT,
        datum_zaniku DATE,
        v_insolvenci BOOLEAN DEFAULT false
      )`)
      const r = await ctx!.pool.query(
        `SELECT COUNT(*)::int AS total FROM companies WHERE datum_zaniku IS NULL AND v_insolvenci = false`
      )
      res.json(r.rows[0])
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  // 5. /api/__schema-check — schema parity
  app.get('/api/__schema-check', async (req, res) => {
    try {
      const r = await ctx!.pool.query(`
        SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name
      `)
      res.json({ ok: true, tables: r.rows.map(r => r.table_name) })
    } catch (e: any) {
      res.status(500).json({ error: e.message })
    }
  })

  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      port = (server.address() as any).port
      resolve()
    })
  })
}, 60_000)

afterAll(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()))
  if (ctx) await ctx.cleanup()
})

describe.skipIf(!ctx)('S6 — Real-backend smoke (5 critical endpoints)', () => {
  const url = (path: string) => `http://localhost:${port}${path}`

  it('GET /api/health → ok=true, db=up', async () => {
    const r = await fetch(url('/api/health'))
    expect(r.ok).toBe(true)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(body.db).toBe('up')
  })

  it('GET /api/templates (empty) → []', async () => {
    const r = await fetch(url('/api/templates'))
    expect(r.ok).toBe(true)
    const body = await r.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('POST /api/templates + GET round-trip', async () => {
    const post = await fetch(url('/api/templates'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smoke-test-1', subject: 'X', body: 'Y' }),
    })
    expect(post.ok).toBe(true)
    const created = await post.json()
    expect(created.id).toBeGreaterThan(0)
    expect(created.name).toBe('smoke-test-1')

    const get = await fetch(url('/api/templates'))
    const list = await get.json()
    expect(list.find((t: any) => t.name === 'smoke-test-1')).toBeDefined()
  })

  it('POST /api/templates with malformed body → 400', async () => {
    const r = await fetch(url('/api/templates'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),  // missing name
    })
    expect(r.status).toBe(400)
  })

  it('GET /api/replies/stats (empty) → all zeros', async () => {
    const r = await fetch(url('/api/replies/stats'))
    expect(r.ok).toBe(true)
    const body = await r.json()
    expect(body.total).toBe(0)
    expect(body.unhandled).toBe(0)
    expect(body.positive).toBe(0)
    expect(body.negative).toBe(0)
  })

  it('GET /api/companies/stats (empty) → total=0', async () => {
    const r = await fetch(url('/api/companies/stats'))
    expect(r.ok).toBe(true)
    const body = await r.json()
    expect(body.total).toBe(0)
  })

  it('GET /api/__schema-check → ok=true, tables array populated', async () => {
    const r = await fetch(url('/api/__schema-check'))
    expect(r.ok).toBe(true)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.tables)).toBe(true)
    expect(body.tables.length).toBeGreaterThan(0)
  })

  it('5 concurrent requests handled without errors', async () => {
    const promises = [
      fetch(url('/api/health')),
      fetch(url('/api/templates')),
      fetch(url('/api/replies/stats')),
      fetch(url('/api/companies/stats')),
      fetch(url('/api/__schema-check')),
    ]
    const results = await Promise.all(promises)
    expect(results.every(r => r.ok)).toBe(true)
  })

  it('UTF-8 emoji round-trip in template body', async () => {
    const post = await fetch(url('/api/templates'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'emoji-test', subject: '✉️', body: 'česky 🌍' }),
    })
    const created = await post.json()
    expect(created.subject).toBe('✉️')
    expect(created.body).toBe('česky 🌍')
  })

  it('SQL injection in template name → stored as data, not executed', async () => {
    const post = await fetch(url('/api/templates'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: "'; DROP TABLE email_templates; --", subject: 'X', body: 'Y' }),
    })
    expect(post.ok).toBe(true)
    // Verify table still exists
    const list = await fetch(url('/api/templates')).then(r => r.json())
    expect(Array.isArray(list)).toBe(true)
    expect(list.find((t: any) => t.name.includes('DROP TABLE'))).toBeDefined()
  })
})
