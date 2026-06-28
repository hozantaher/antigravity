// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — D2.9 server.js contacts extraction
//
//  Locks the response shape + SQL contract for the 5 routes moved from
//  server.js into src/server-routes/contacts.js as part of sprint D2.9
//  (2026-05-02).
//
//  Routes covered:
//    GET    /api/contacts                  — paginated list + suppression flag
//    GET    /api/contacts/:id              — detail + send_history (last 20)
//    PATCH  /api/contacts/:id              — partial update (4 allowed cols)
//    POST   /api/contacts/:id/verify-email — SMTP verify (mocked verifyEmail)
//    DELETE /api/contacts/:id              — drop row
//
//  Strategy mirrors bff-templates-d26-extract: pg.Pool is mocked, BFF is
//  booted via app.listen(0), tests exercise real Express dispatch through
//  the mounter wiring. Memory: project_two_suppression_tables — list +
//  detail SELECTs MUST consult both `outreach_suppressions` AND
//  `suppression_list` via the canonical `suppressionExistsFor` fragment.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    async connect() {
      return {
        query: async (sql: string, params?: unknown[]) => {
          // Transaction-control statements are infra, not business queries:
          // short-circuit them WITHOUT shifting the shared queue (mirrors the
          // bff-contacts / api-response-envelope mocks). Mutating handlers now
          // wrap work in BEGIN … COMMIT with a pre-SELECT + audit INSERT, so
          // unless BEGIN is short-circuited it would eat the first queued row.
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(typeof sql === 'string' ? sql : '')) return { rows: [], rowCount: 0 }
          calls.push({ sql, params })
          if (!queryQueue.length) return { rows: [], rowCount: 0 }
          const next = queryQueue.shift()!
          if (next instanceof Error) throw next
          return next
        },
        release: () => {},
      }
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})

// emailProbe.verifyEmail is mocked so the verify-email handler is fully
// deterministic — no real DNS / SMTP probe.
vi.mock('../../src/lib/emailProbe.js', () => ({
  verifyEmail: vi.fn(async () => ({
    status: 'valid',
    confidence: 0.92,
    syntax_valid: true,
    mx_exists: true,
    smtp_valid: true,
    smtp_response: '250 OK',
  })),
}))

vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'EMAIL_VERIFY_SMTP']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.EMAIL_VERIFY_SMTP = '0'
  const mod = await import('../../server.js')
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, headers: r.headers }
}

async function send(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/contacts
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/contacts', () => {
  it('200 returns { rows, total } with both queries (count + page)', async () => {
    queueRows([{ total: 0 }])         // count query
    queueRows([])                     // page query
    const res = await get('/api/contacts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ rows: [], total: 0 })
    // Two queries: COUNT then SELECT
    const countCall = calls.find(c => /SELECT COUNT\(\*\)::int AS total FROM contacts/.test(c.sql))
    const pageCall  = calls.find(c => /FROM contacts c[\s\S]+ORDER BY last_contact_at DESC NULLS LAST/.test(c.sql))
    expect(countCall).toBeTruthy()
    expect(pageCall).toBeTruthy()
  })

  it('200 surfaces total from count + rows from page query', async () => {
    queueRows([{ total: 42 }])
    queueRows([{ id: 1, email: 'a@b.cz', first_name: 'A', last_name: 'B', company_name: null,
                 status: 'active', email_status: 'valid', email_verified_at: null,
                 email_confidence: 0.9, last_contact_at: null, total_sent: 0, suppressed: false }])
    const res = await get('/api/contacts')
    expect(res.status).toBe(200)
    const body = res.body as { rows: unknown[]; total: number }
    expect(body.total).toBe(42)
    expect(body.rows.length).toBe(1)
  })

  it('SQL contract — page SELECT consults BOTH suppression tables (UNION discipline)', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await get('/api/contacts')
    const pageCall = calls.find(c => /ORDER BY last_contact_at DESC NULLS LAST/.test(c.sql))
    expect(pageCall?.sql).toMatch(/outreach_suppressions/)
    expect(pageCall?.sql).toMatch(/suppression_list/)
    // Normalisation guard — both branches must lower(trim(email)) so case/
    // whitespace drift between writers cannot leak through.
    expect(pageCall?.sql).toMatch(/lower\(trim\(/)
  })

  it('search filter wires ILIKE on email/first/last/company with single bound param', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await get('/api/contacts?search=acme')
    const pageCall = calls.find(c => /ORDER BY last_contact_at DESC NULLS LAST/.test(c.sql))
    expect(pageCall?.sql).toMatch(/c\.email ILIKE/)
    expect(pageCall?.sql).toMatch(/c\.company_name ILIKE/)
    // %acme% bound once (used 4× in the OR clause via $1 reuse)
    expect(pageCall?.params?.[0]).toBe('%acme%')
  })

  it('status filter binds c.status', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await get('/api/contacts?status=active')
    const pageCall = calls.find(c => /ORDER BY last_contact_at DESC NULLS LAST/.test(c.sql))
    expect(pageCall?.sql).toMatch(/c\.status=\$/)
    expect(pageCall?.params).toContain('active')
  })

  it('limit/offset default to 100/0 and are bound as numbers', async () => {
    queueRows([{ total: 0 }])
    queueRows([])
    await get('/api/contacts')
    const pageCall = calls.find(c => /ORDER BY last_contact_at DESC NULLS LAST/.test(c.sql))
    const params = pageCall?.params as unknown[]
    // Last two params are LIMIT, OFFSET
    expect(params[params.length - 2]).toBe(100)
    expect(params[params.length - 1]).toBe(0)
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/contacts')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/contacts/:id
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/contacts/:id', () => {
  it('404 when no contact found', async () => {
    queueRows([])  // contact lookup returns empty
    const res = await get('/api/contacts/99')
    expect(res.status).toBe(404)
    expect((res.body as { error: string }).error).toBe('not found')
  })

  it('200 returns contact + send_history array', async () => {
    queueRows([{ id: 7, email: 'x@y.cz', first_name: 'X', last_name: 'Y', company_name: 'Acme',
                 status: 'active', email_status: 'valid', email_verified_at: null,
                 email_verification: null, email_confidence: 0.8, suppressed: false }])  // detail SELECT
    queueRows([])  // campaigns sub-SELECT (detail enrichment, contacts.js:149)
    queueRows([
      { sent_at: '2026-05-01T10:00:00Z', status: 'sent', subject: 'Hi', smtp_response: '250 OK', mailbox_email: 'a@b.cz' },
    ])  // send_history SELECT
    const res = await get('/api/contacts/7')
    expect(res.status).toBe(200)
    const body = res.body as { id: number; send_history: unknown[] }
    expect(body.id).toBe(7)
    expect(Array.isArray(body.send_history)).toBe(true)
    expect(body.send_history.length).toBe(1)
  })

  it('SQL contract — detail SELECT consults BOTH suppression tables', async () => {
    queueRows([{ id: 7, email: 'x@y.cz', suppressed: false }])
    queueRows([])
    await get('/api/contacts/7')
    const detailCall = calls.find(c => /FROM contacts c WHERE c\.id=\$1/.test(c.sql))
    expect(detailCall?.sql).toMatch(/outreach_suppressions/)
    expect(detailCall?.sql).toMatch(/suppression_list/)
    expect(detailCall?.sql).toMatch(/lower\(trim\(/)
  })

  it('send_history join uses outreach_mailboxes.from_address', async () => {
    queueRows([{ id: 7, email: 'x@y.cz', suppressed: false }])
    queueRows([])
    await get('/api/contacts/7')
    const histCall = calls.find(c => /LEFT JOIN outreach_mailboxes/.test(c.sql))
    expect(histCall?.sql).toMatch(/m\.from_address=se\.mailbox_used/)
    expect(histCall?.sql).toMatch(/LIMIT 20/)
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/contacts/7')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PATCH /api/contacts/:id
// ═══════════════════════════════════════════════════════════════════════

describe('PATCH /api/contacts/:id', () => {
  it('400 when no allowed field provided', async () => {
    queueRows([{ id: 1, email: 'a@b.cz', status: 'active' }])  // pre-SELECT existence (audit txn, contacts.js:194)
    const res = await send('PATCH', '/api/contacts/1', { id: 99, email: 'evil@x.cz' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('nothing to update')
  })

  it('400 with empty body', async () => {
    queueRows([{ id: 1, email: 'a@b.cz', status: 'active' }])  // pre-SELECT existence (audit txn, contacts.js:194)
    const res = await send('PATCH', '/api/contacts/1', {})
    expect(res.status).toBe(400)
  })

  it('200 returns updated row when status set', async () => {
    queueRows([{ id: 1, email: 'a@b.cz', status: 'active' }])    // pre-SELECT existence (audit txn)
    queueRows([{ id: 1, email: 'a@b.cz', first_name: 'A', last_name: 'B',
                 company_name: 'Acme', status: 'paused' }])      // UPDATE ... RETURNING
    const res = await send('PATCH', '/api/contacts/1', { status: 'paused' })
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('paused')
    const updateCall = calls.find(c => /UPDATE contacts SET/.test(c.sql))
    expect(updateCall?.sql).toMatch(/RETURNING id,email,first_name,last_name,company_name,status/)
    // params: [status, id]
    expect(updateCall?.params?.[0]).toBe('paused')
    expect(updateCall?.params?.[1]).toBe('1')
  })

  it('only allowed columns are written (email + id ignored)', async () => {
    queueRows([{ id: 1, email: 'a@b.cz', status: 'active' }])         // pre-SELECT existence (audit txn)
    queueRows([{ id: 1, status: 'active', first_name: 'NewName' }])   // UPDATE ... RETURNING
    await send('PATCH', '/api/contacts/1', {
      first_name: 'NewName',
      email: 'attacker@evil.cz',  // not in allow-list
      id: 99,                     // not in allow-list
    })
    const updateCall = calls.find(c => /UPDATE contacts SET/.test(c.sql))
    expect(updateCall?.sql).not.toMatch(/email=\$/)
    expect(updateCall?.sql).toMatch(/first_name=\$/)
  })

  it('404 when id does not exist (RETURNING produces empty rowset)', async () => {
    queueRows([])  // nothing returned
    const res = await send('PATCH', '/api/contacts/999', { status: 'paused' })
    expect(res.status).toBe(404)
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await send('PATCH', '/api/contacts/1', { status: 'paused' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/contacts/:id/verify-email
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/contacts/:id/verify-email', () => {
  it('404 when contact not found', async () => {
    queueRows([])  // contact lookup empty
    const res = await send('POST', '/api/contacts/99/verify-email')
    expect(res.status).toBe(404)
    expect((res.body as { error: string }).error).toBe('not found')
  })

  it('200 with status=no_email + UPDATE writes email_status=no_email when no email', async () => {
    queueRows([{ id: 7, email: null }])  // contact exists, no email
    queueRows([])                        // UPDATE contacts SET email_status='no_email'
    const res = await send('POST', '/api/contacts/7/verify-email')
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('no_email')
    const updateCall = calls.find(c => /SET email_status='no_email'/.test(c.sql))
    expect(updateCall).toBeTruthy()
    expect(updateCall?.params).toEqual([7])
  })

  it('200 with verifyEmail result + persists to email_verification jsonb', async () => {
    queueRows([{ id: 7, email: 'a@example.com' }])
    queueRows([])  // post-verify UPDATE
    const res = await send('POST', '/api/contacts/7/verify-email')
    expect(res.status).toBe(200)
    const body = res.body as { status: string; confidence: number }
    expect(body.status).toBe('valid')
    expect(body.confidence).toBe(0.92)
    // Persist UPDATE has 4 params: status, jsonb, confidence, id
    const persistCall = calls.find(c => /SET email_status=\$1, email_verified_at=now\(\), email_verification=\$2, email_confidence=\$3/.test(c.sql))
    expect(persistCall).toBeTruthy()
    expect(persistCall?.params?.[0]).toBe('valid')
    expect(persistCall?.params?.[3]).toBe(7)
    // jsonb param is a string (JSON.stringify-d result)
    expect(typeof persistCall?.params?.[1]).toBe('string')
  })

  it('500 on initial pg throw', async () => {
    queueError('boom')
    const res = await send('POST', '/api/contacts/7/verify-email')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/contacts/:id
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/contacts/:id', () => {
  it('200 returns { ok: true } on success', async () => {
    queueRows([{ id: 5, email: 'a@b.cz', status: 'active' }])  // pre-SELECT existence (audit txn, contacts.js:367)
    queueRows([{ id: 5 }])                                      // DELETE ... RETURNING id
    const res = await send('DELETE', '/api/contacts/5')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const deleteCall = calls.find(c => /DELETE FROM contacts WHERE id=\$1 RETURNING id/.test(c.sql))
    expect(deleteCall?.params).toEqual(['5'])
  })

  it('404 when id does not exist (RETURNING is empty)', async () => {
    queueRows([])
    const res = await send('DELETE', '/api/contacts/999')
    expect(res.status).toBe(404)
  })

  it('500 on pg throw', async () => {
    queueError('foreign key violation')
    const res = await send('DELETE', '/api/contacts/5')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Routing invariants — Express ordering preserved from server.js
// ═══════════════════════════════════════════════════════════════════════

describe('Contacts routing invariants', () => {
  it('POST /api/contacts/:id/verify-email is NOT swallowed by GET /:id', async () => {
    // verify-email handler reads contact first (1 row); a stray GET /:id route
    // would 404 / 200-ify the wrong shape. Confirm we actually hit the POST.
    queueRows([{ id: 7, email: null }])
    queueRows([])
    const res = await send('POST', '/api/contacts/7/verify-email')
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('no_email')
  })
})
