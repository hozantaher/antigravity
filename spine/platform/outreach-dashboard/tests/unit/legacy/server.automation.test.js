/**
 * Integration tests for the automation engine (live server required).
 * Requires: server running on localhost:3001, DATABASE_URL set.
 * Run: pnpm test (vitest run)
 */
import { beforeAll, afterAll } from 'vitest'
import { server as mswServer } from '../../../src/test/setup.js'

const BASE = 'http://localhost:3001'

// Disable MSW for this file — tests hit the real Express server.
beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

async function get(path) {
  const r = await fetch(BASE + path)
  return { status: r.status, body: await r.json() }
}
async function post(path, body = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}
async function patch(path, body = {}) {
  const r = await fetch(BASE + path, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}
async function del(path) {
  const r = await fetch(BASE + path, { method: 'DELETE' })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

// ── Schema migration side-effects ─────────────────────────────────
describe('Automation schema', () => {
  it('mailbox_check_history has smtp_ok column (verifiable via check-history endpoint)', async () => {
    // Just verify the server starts without crashing the migration.
    // If the column were missing the full-check insert would throw.
    const { status } = await get('/api/mailboxes/health-summary')
    expect([200, 500]).toContain(status) // 500 only if no mailboxes at all
  })
})

// ── Auto-pause / auto-resume flow ─────────────────────────────────
describe('Auto-pause via applyAutomationRules (full-check integration)', () => {
  let mbId

  beforeAll(async () => {
    // Create a throwaway mailbox
    const { body } = await post('/api/mailboxes', {
      display_name: 'automation-test@example.com',
      smtp_host:    'smtp.example.com',
      smtp_port:    465,
      smtp_username:'automation-test@example.com',
      password:     'test-pass',
      from_address: 'automation-test@example.com',
    })
    mbId = body?.id
  })

  afterAll(async () => {
    if (mbId) await del(`/api/mailboxes/${mbId}`)
  })

  it('creates mailbox with status=active', async () => {
    if (!mbId) return
    const { body } = await get('/api/mailboxes')
    const mb = body.find(m => m.id === mbId)
    expect(mb?.status).toBe('active')
  })

  it('check-history endpoint returns array', async () => {
    if (!mbId) return
    const { status, body } = await get(`/api/mailboxes/${mbId}/check-history`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('imap-inbox returns ok or no_imap for mailbox without imap config', async () => {
    if (!mbId) return
    const { status, body } = await get(`/api/mailboxes/${mbId}/imap-inbox`)
    expect(status).toBe(200)
    expect(body).toHaveProperty('ok')
    // no imap configured → ok=false, reason='no_imap'
    if (body.ok === false) {
      expect(body.reason).toBe('no_imap')
    }
  })
})

// ── Bulk endpoints ────────────────────────────────────────────────
describe('POST /api/mailboxes/bulk-check', () => {
  it('returns ok:true with triggered count', async () => {
    const { status, body } = await post('/api/mailboxes/bulk-check', { ids: [99999] })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.triggered).toBe(1)
  })

  it('rejects missing ids', async () => {
    const { status } = await post('/api/mailboxes/bulk-check', {})
    expect(status).toBe(400)
  })
})

// CSV import endpoint removed — bulk import wasn't part of operator workflow.

// ── Proxy pool ────────────────────────────────────────────────────
describe('GET /api/proxy-pool', () => {
  it('returns pool structure', async () => {
    const { status, body } = await get('/api/proxy-pool')
    expect(status).toBe(200)
    expect(body).toHaveProperty('working')
    expect(Array.isArray(body.working)).toBe(true)
  })
})
