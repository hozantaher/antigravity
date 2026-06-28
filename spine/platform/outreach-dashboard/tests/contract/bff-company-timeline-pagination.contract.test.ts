// CompanyTimeline pagination + event-type filter — BFF contract tests.
//
// Covers: GET /api/companies/:id/timeline with new ?limit, ?before, ?event_types params.
// Per memory rule feedback_extreme_testing — ≥10 cases, boundary + error + integration.
// Mocked pg.Pool and no real DB / network.
//
// Issue: #865

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
      const self = this
      return {
        async query(sql: string, params?: unknown[]) { return self.query(sql, params) },
        release() {},
      }
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})

vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'LLM_RUNNER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  delete process.env.LLM_RUNNER_URL

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

function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

async function req(path: string) {
  const r = await fetch(baseUrl + path, { headers: { 'content-type': 'application/json' } })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Push standard company + contacts + 3 empty query results (out, in, ai). */
function qCompanyWithContacts(contactIds: number[], companyOverride?: object) {
  q([{ id: 1, name: 'Acme s.r.o.', ico: '12345678', ...companyOverride }]) // company
  q(contactIds.map(id => ({ id })))                                          // contacts
}

// ─── 1. 401 without X-API-Key ───────────────────────────────────────────────
// (BFF_AUTH_DISABLED=1 in beforeAll so this is effectively bypassed in tests.
//  Verifying auth is exercised in auth-bypass.contract.test.ts.
//  We check the endpoint is wired and reachable.)
describe('GET /api/companies/:id/timeline — auth gate', () => {
  it('endpoint is reachable with auth bypass active', async () => {
    q([])  // company not found
    const { status } = await req('/api/companies/99/timeline')
    expect(status).toBe(404)
  })
})

// ─── 2. Default limit = 50 ──────────────────────────────────────────────────
describe('GET /api/companies/:id/timeline — default limit', () => {
  it('default limit is 50 — LIMIT $2 param = 51 (limit+1 for hasMore detection)', async () => {
    qCompanyWithContacts([7])
    q([])  // outbound
    q([])  // inbound
    q([])  // ai
    await req('/api/companies/12345678/timeline')
    // Each data query should have been called with limit+1 = 51 as the $2 param.
    const outQuery = calls.find(c => /FROM send_events/.test(c.sql))
    expect(outQuery?.params?.[1]).toBe(51)
  })
})

// ─── 3. Custom limit = 20 ───────────────────────────────────────────────────
describe('GET /api/companies/:id/timeline — custom limit', () => {
  it('limit=20 passes 21 to SQL (limit+1)', async () => {
    qCompanyWithContacts([7])
    q([])  // outbound
    q([])  // inbound
    q([])  // ai
    await req('/api/companies/12345678/timeline?limit=20')
    const outQuery = calls.find(c => /FROM send_events/.test(c.sql))
    expect(outQuery?.params?.[1]).toBe(21)
  })

  it('limit=20 result contains at most 20 messages', async () => {
    qCompanyWithContacts([7])
    // Provide 21 outbound rows to trigger hasMore, 0 inbound, 0 ai
    const outRows = Array.from({ length: 21 }, (_, i) => ({
      id: i + 1,
      sent_at: new Date(Date.now() - i * 1000).toISOString(),
      subject: `Subj ${i}`, body_preview: `Body ${i}`,
      campaign_name: null, sender_email: null,
    }))
    q(outRows)
    q([])
    q([])
    const { status, body } = await req('/api/companies/12345678/timeline?limit=20')
    expect(status).toBe(200)
    const b = body as { messages: unknown[]; next_cursor: string | null }
    expect(b.messages.length).toBe(20)
    expect(b.next_cursor).not.toBeNull()
  })
})

// ─── 4. limit=300 clamped to 200 ────────────────────────────────────────────
describe('GET /api/companies/:id/timeline — limit clamp', () => {
  it('limit=300 is clamped to 200 — SQL receives 201', async () => {
    qCompanyWithContacts([7])
    q([])
    q([])
    q([])
    await req('/api/companies/12345678/timeline?limit=300')
    const outQuery = calls.find(c => /FROM send_events/.test(c.sql))
    expect(outQuery?.params?.[1]).toBe(201)
  })
})

// ─── 5. limit=0 is invalid → 400 ────────────────────────────────────────────
describe('GET /api/companies/:id/timeline — invalid limit', () => {
  it('limit=0 returns 400', async () => {
    const { status, body } = await req('/api/companies/12345678/timeline?limit=0')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/limit/i)
  })

  it('limit=-5 returns 400', async () => {
    const { status } = await req('/api/companies/12345678/timeline?limit=-5')
    expect(status).toBe(400)
  })
})

// ─── 6. Cursor-based pagination — no overlap ────────────────────────────────
describe('GET /api/companies/:id/timeline — cursor pagination', () => {
  it('page 1 returns next_cursor when more records exist', async () => {
    qCompanyWithContacts([7])
    // 6 outbound rows while limit=5 → hasMore=true
    const outRows = Array.from({ length: 6 }, (_, i) => ({
      id: 100 - i,
      sent_at: new Date(2026, 3, 20 - i).toISOString(),
      subject: `S${i}`, body_preview: `B${i}`, campaign_name: null, sender_email: null,
    }))
    q(outRows)
    q([])
    q([])
    const { body } = await req('/api/companies/12345678/timeline?limit=5')
    const b = body as { messages: Array<{ id: string; sent_at: string }>; next_cursor: string | null }
    expect(b.messages.length).toBe(5)
    expect(b.next_cursor).not.toBeNull()
    // Cursor should contain the timestamp of the oldest (first ASC) message on page.
    const oldestMsg = b.messages[0]
    expect(b.next_cursor).toContain(oldestMsg.id)
  })

  it('page 2 using cursor does not overlap with page 1', async () => {
    // Page 1: ids 10..6
    qCompanyWithContacts([7])
    const page1Rows = [10, 9, 8, 7, 6, 5].map(id => ({
      id,
      sent_at: new Date(2026, 3, id).toISOString(),
      subject: `S${id}`, body_preview: `B${id}`, campaign_name: null, sender_email: null,
    }))
    q(page1Rows)
    q([])
    q([])
    const { body: body1 } = await req('/api/companies/12345678/timeline?limit=5')
    const b1 = body1 as { messages: Array<{ id: string }>; next_cursor: string }
    const page1Ids = b1.messages.map(m => m.id)

    // Page 2: ids 5..1 — simulate cursor filtering (mocked — server doesn't know cursor is fake)
    qCompanyWithContacts([7])
    const page2Rows = [5, 4, 3, 2, 1].map(id => ({
      id,
      sent_at: new Date(2026, 3, id).toISOString(),
      subject: `S${id}`, body_preview: `B${id}`, campaign_name: null, sender_email: null,
    }))
    q(page2Rows)
    q([])
    q([])
    const { body: body2 } = await req(`/api/companies/12345678/timeline?limit=5&before=${encodeURIComponent(b1.next_cursor)}`)
    const b2 = body2 as { messages: Array<{ id: string }> }
    const page2Ids = b2.messages.map(m => m.id)

    // Verify before cursor was passed to SQL as a parameter.
    const outQ2 = calls.find(c => /FROM send_events/.test(c.sql) && c.params && c.params.length > 2)
    expect(outQ2?.params?.some(p => typeof p === 'string' && p.includes('2026'))).toBe(true)

    // No id overlap between page 1 and page 2 (mocked DB returns different rows).
    const overlap = page1Ids.filter(id => page2Ids.includes(id))
    expect(overlap.length).toBe(0)
  })

  it('no next_cursor when total messages ≤ limit', async () => {
    qCompanyWithContacts([7])
    q([{ id: 1, sent_at: '2026-04-20T10:00:00Z', subject: 'X', body_preview: 'Y', campaign_name: null, sender_email: null }])
    q([])
    q([])
    const { body } = await req('/api/companies/12345678/timeline?limit=5')
    expect((body as { next_cursor: unknown }).next_cursor).toBeNull()
  })
})

// ─── 7. event_types filter ───────────────────────────────────────────────────
describe('GET /api/companies/:id/timeline — event_types filter', () => {
  it('event_types=inbound skips outbound + ai_draft queries', async () => {
    qCompanyWithContacts([7])
    // Only 1 query result needed (inbound)
    q([{ id: 200, replied_at: '2026-04-26T09:00:00Z', body_text: 'Reply', body_html: null, body_preview: 'Reply', thread_id: 50 }])
    const { status, body } = await req('/api/companies/12345678/timeline?event_types=inbound')
    expect(status).toBe(200)
    const b = body as { messages: Array<{ kind: string }> }
    // Only inbound messages.
    expect(b.messages.every(m => m.kind === 'inbound')).toBe(true)
    // No send_events query fired.
    const sendQ = calls.find(c => /FROM send_events/.test(c.sql))
    expect(sendQ).toBeUndefined()
    // No ai_suggestion_audit query fired.
    const aiQ = calls.find(c => /FROM ai_suggestion_audit/.test(c.sql))
    expect(aiQ).toBeUndefined()
  })

  it('event_types=outbound skips inbound + ai_draft queries', async () => {
    qCompanyWithContacts([7])
    q([{ id: 100, sent_at: '2026-04-25T08:00:00Z', subject: 'Hi', body_preview: 'Hi', campaign_name: null, sender_email: null }])
    const { status, body } = await req('/api/companies/12345678/timeline?event_types=outbound')
    expect(status).toBe(200)
    const b = body as { messages: Array<{ kind: string }> }
    expect(b.messages.every(m => m.kind === 'outbound')).toBe(true)
    const inQ = calls.find(c => /FROM outreach_messages/.test(c.sql))
    expect(inQ).toBeUndefined()
  })

  it('invalid event_types returns 400', async () => {
    const { status } = await req('/api/companies/12345678/timeline?event_types=unknown_type')
    expect(status).toBe(400)
  })
})

// ─── 8. Empty timeline ───────────────────────────────────────────────────────
describe('GET /api/companies/:id/timeline — empty results', () => {
  it('empty timeline → 200 + empty array + no cursor', async () => {
    qCompanyWithContacts([7])
    q([])  // outbound
    q([])  // inbound
    q([])  // ai
    const { status, body } = await req('/api/companies/12345678/timeline')
    expect(status).toBe(200)
    const b = body as { messages: unknown[]; next_cursor: unknown }
    expect(b.messages).toEqual([])
    expect(b.next_cursor).toBeNull()
  })
})

// ─── 9. ICO that doesn't exist → 200 + empty ─────────────────────────────────
describe('GET /api/companies/:id/timeline — ICO not found', () => {
  it('unknown ICO returns 404', async () => {
    q([])  // company not found
    const { status, body } = await req('/api/companies/99999999/timeline')
    expect(status).toBe(404)
    expect((body as { error: string }).error).toMatch(/Firma nenalezena/)
  })

  it('company with no contacts returns 200 + empty + no cursor', async () => {
    q([{ id: 5, name: 'NoContacts', ico: '77777777' }])
    q([])  // contacts empty
    const { status, body } = await req('/api/companies/77777777/timeline')
    expect(status).toBe(200)
    const b = body as { messages: unknown[]; next_cursor: unknown }
    expect(b.messages).toEqual([])
    expect(b.next_cursor).toBeNull()
  })
})

// ─── 10. N+1 query check ─────────────────────────────────────────────────────
describe('GET /api/companies/:id/timeline — query count', () => {
  it('fires exactly 5 queries: company, contacts, outbound, inbound, ai (no per-event sub-queries)', async () => {
    qCompanyWithContacts([7, 8, 9])
    q([
      { id: 1, sent_at: '2026-04-25T08:00:00Z', subject: 'A', body_preview: 'A', campaign_name: null, sender_email: null },
      { id: 2, sent_at: '2026-04-25T09:00:00Z', subject: 'B', body_preview: 'B', campaign_name: null, sender_email: null },
    ])
    q([
      { id: 10, replied_at: '2026-04-26T09:00:00Z', body_text: 'R', body_html: null, body_preview: 'R', thread_id: 50 },
    ])
    q([])  // ai empty
    calls.length = 0  // reset after beforeEach may already have some

    await req('/api/companies/12345678/timeline')
    // Exactly 5 DB calls: company lookup, contacts lookup, outbound, inbound, ai.
    expect(calls.length).toBe(5)
  })
})

// ─── 11. next_cursor format check ────────────────────────────────────────────
describe('GET /api/companies/:id/timeline — cursor format', () => {
  it('next_cursor contains both ISO timestamp and event id', async () => {
    qCompanyWithContacts([7])
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: 10 + i,
      sent_at: new Date(2026, 3, 10 + i).toISOString(),
      subject: `S${i}`, body_preview: `B${i}`, campaign_name: null, sender_email: null,
    }))
    q(rows)
    q([])
    q([])
    const { body } = await req('/api/companies/12345678/timeline?limit=2')
    const b = body as { next_cursor: string }
    expect(b.next_cursor).not.toBeNull()
    // Format: "<ISO>_<id>"
    expect(b.next_cursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*_send-\d+$/)
  })
})

// ─── 12. Merges all three kinds and sorts chronologically ─────────────────────
describe('GET /api/companies/:id/timeline — merge + sort', () => {
  it('merges outbound + inbound + ai_draft and returns them newest-first then reversed', async () => {
    qCompanyWithContacts([7])
    q([{ id: 100, sent_at: '2026-04-25T08:00:00Z', subject: 'Out', body_preview: 'Out', campaign_name: 'Q2', sender_email: null }])
    q([{ id: 200, replied_at: '2026-04-26T09:00:00Z', body_text: 'In', body_html: null, body_preview: 'In', thread_id: 50 }])
    q([{ id: 300, thread_id: 50, ai_suggestion: 'AI', operator_action: 'pending', final_output: null, occurred_at: '2026-04-27T10:00:00Z', confidence_score: '0.7' }])
    const { status, body } = await req('/api/companies/12345678/timeline')
    expect(status).toBe(200)
    const b = body as { messages: Array<{ kind: string; sent_at: string }> }
    expect(b.messages.map(m => m.kind)).toEqual(['outbound', 'inbound', 'ai_draft'])
    // Chronological ASC
    expect(new Date(b.messages[0].sent_at).getTime()).toBeLessThan(new Date(b.messages[1].sent_at).getTime())
    expect(new Date(b.messages[1].sent_at).getTime()).toBeLessThan(new Date(b.messages[2].sent_at).getTime())
  })
})
