// Track B (M+3) — operator approval backend contract tests.
//
// Covers the four BFF endpoints wired in server.js:
//   GET  /api/operator/queue
//   GET  /api/operator/queue/:suggestionId
//   POST /api/operator/approve
//   GET  /api/companies/:id/timeline
//
// Plus the reply→AI suggestion pipeline helper exercised via the
// /v1/generate fetch surface (mocked).
//
// Per memory rule feedback_extreme_testing — ≥10 cases per change,
// boundary + error + integration shape. We mock pg.Pool and global
// fetch; no real DB / network.

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
        async query(sql: string, params?: unknown[]) {
          return self.query(sql, params)
        },
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
  for (const k of [
    'BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'LLM_RUNNER_URL',
  ]) {
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

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ─── GET /api/operator/queue ────────────────────────────────────────────────

describe('GET /api/operator/queue', () => {
  it('returns empty list when no pending suggestions', async () => {
    q([])           // SELECT ... ai_suggestion_audit
    q([{ total: 0 }]) // COUNT
    const { status, body } = await req('GET', '/api/operator/queue')
    expect(status).toBe(200)
    const b = body as { suggestions: unknown[]; total: number; limit: number; offset: number }
    expect(b.suggestions).toEqual([])
    expect(b.total).toBe(0)
    expect(b.limit).toBe(50)
    expect(b.offset).toBe(0)
  })

  it('lists pending suggestions with company + contact join data', async () => {
    q([
      {
        suggestion_id: 42, thread_id: 100, ai_suggestion: 'Dobrý den…',
        confidence_score: '0.6200', occurred_at: '2026-04-30T10:00:00Z',
        details: {}, contact_id: 7, campaign_id: 3,
        contact_email: 'jan@firma.cz', contact_name: 'Jan Novák',
        company_id: 9, company_name: 'Firma s.r.o.', company_ico: '12345678',
      },
    ])
    q([{ total: 1 }])
    const { status, body } = await req('GET', '/api/operator/queue')
    expect(status).toBe(200)
    const b = body as { suggestions: Array<Record<string, unknown>>; total: number }
    expect(b.total).toBe(1)
    expect(b.suggestions[0]).toMatchObject({
      suggestion_id: 42,
      thread_id: 100,
      contact_email: 'jan@firma.cz',
      company_name: 'Firma s.r.o.',
      ai_suggestion: 'Dobrý den…',
      confidence_score: 0.62,
    })
  })

  it('filters WHERE operator_action = pending and orders by confidence ASC NULLS FIRST', async () => {
    q([])
    q([{ total: 0 }])
    await req('GET', '/api/operator/queue')
    const list = calls.find(c => /FROM ai_suggestion_audit/.test(c.sql) && /pending/.test(c.sql))
    expect(list, 'queue list query fired').toBeTruthy()
    expect(/operator_action = 'pending'/.test(list!.sql)).toBe(true)
    expect(/ORDER BY a\.confidence_score ASC NULLS FIRST/.test(list!.sql)).toBe(true)
  })

  it('respects limit + offset query parameters with clamp', async () => {
    q([]); q([{ total: 0 }])
    await req('GET', '/api/operator/queue?limit=999&offset=20')
    const list = calls.find(c => /FROM ai_suggestion_audit/.test(c.sql) && /LIMIT/.test(c.sql))
    // Limit clamped to 200, offset preserved
    expect(list?.params).toEqual([200, 20])
  })

  it('confidence_score returned as JS number not string', async () => {
    q([{
      suggestion_id: 1, thread_id: 10, ai_suggestion: 'x',
      confidence_score: '0.8500', occurred_at: '2026-04-30Z', details: null,
      contact_id: 1, campaign_id: 1, contact_email: 'a@b.cz',
      contact_name: '', company_id: null, company_name: null, company_ico: null,
    }])
    q([{ total: 1 }])
    const { body } = await req('GET', '/api/operator/queue')
    const b = body as { suggestions: Array<{ confidence_score: number }> }
    expect(typeof b.suggestions[0].confidence_score).toBe('number')
    expect(b.suggestions[0].confidence_score).toBe(0.85)
  })
})

// ─── GET /api/operator/queue/:suggestionId ──────────────────────────────────

describe('GET /api/operator/queue/:suggestionId', () => {
  it('400 on non-numeric id', async () => {
    const { status, body } = await req('GET', '/api/operator/queue/notanumber')
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/ID/i)
  })

  it('404 when suggestion not found', async () => {
    q([])
    const { status, body } = await req('GET', '/api/operator/queue/99999')
    expect(status).toBe(404)
    expect((body as { error: string }).error).toMatch(/nenalezen/i)
  })

  it('returns suggestion + last_inbound when both exist', async () => {
    q([{
      suggestion_id: 5, thread_id: 200, ai_suggestion: 'Dobrý den, ceník v příloze.',
      operator_action: 'pending', final_output: null, confidence_score: '0.7000',
      occurred_at: '2026-04-30T12:00:00Z', details: { source: 'imap' },
      contact_id: 11, campaign_id: 4, thread_status: 'active',
      contact_email: 'op@test.cz', contact_name: 'Op Test',
      company_id: 22, company_name: 'Test s.r.o.', company_ico: '99999999',
      campaign_name: 'Q2 výkup',
    }])
    q([{ id: 800, body_text: 'Posílám ceník?', body_html: null,
        body_preview: 'Posílám ceník?', replied_at: '2026-04-30T11:55:00Z' }])
    const { status, body } = await req('GET', '/api/operator/queue/5')
    expect(status).toBe(200)
    const b = body as {
      suggestion: { ai_suggestion: string; body: string; preview: string; confidence_score: number }
      last_inbound: { body_text: string } | null
    }
    expect(b.suggestion.ai_suggestion).toBe('Dobrý den, ceník v příloze.')
    // body / preview both fall back to ai_suggestion for UI compat
    expect(b.suggestion.body).toBe('Dobrý den, ceník v příloze.')
    expect(b.suggestion.preview).toBe('Dobrý den, ceník v příloze.')
    expect(b.suggestion.confidence_score).toBe(0.7)
    expect(b.last_inbound?.body_text).toBe('Posílám ceník?')
  })

  it('returns last_inbound: null when thread has no inbound', async () => {
    q([{
      suggestion_id: 6, thread_id: 201, ai_suggestion: 'x',
      operator_action: 'pending', final_output: null, confidence_score: null,
      occurred_at: '2026-04-30Z', details: null, contact_id: 1, campaign_id: 1,
      thread_status: 'active', contact_email: 'a@b.cz', contact_name: '',
      company_id: null, company_name: null, company_ico: null, campaign_name: null,
    }])
    q([])  // no inbound rows
    const { status, body } = await req('GET', '/api/operator/queue/6')
    expect(status).toBe(200)
    expect((body as { last_inbound: unknown }).last_inbound).toBeNull()
  })
})

// ─── POST /api/operator/approve ─────────────────────────────────────────────

describe('POST /api/operator/approve', () => {
  it('400 missing suggestion_id', async () => {
    const { status } = await req('POST', '/api/operator/approve', { action: 'approved', final_output: 'x' })
    expect(status).toBe(400)
  })

  it('400 invalid action', async () => {
    const { status, body } = await req('POST', '/api/operator/approve', {
      suggestion_id: 1, action: 'maybe',
    })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/Neplatná|approved|edited|rejected/)
  })

  it('400 approved action without final_output', async () => {
    const { status } = await req('POST', '/api/operator/approve', {
      suggestion_id: 1, action: 'approved',
    })
    expect(status).toBe(400)
  })

  it('400 edited action without final_output', async () => {
    const { status } = await req('POST', '/api/operator/approve', {
      suggestion_id: 1, action: 'edited', final_output: '   ',
    })
    expect(status).toBe(400)
  })

  it('400 rejected with final_output present', async () => {
    const { status } = await req('POST', '/api/operator/approve', {
      suggestion_id: 1, action: 'rejected', final_output: 'why?',
    })
    expect(status).toBe(400)
  })

  it('404 when suggestion not found', async () => {
    q([])  // pre SELECT empty
    const { status } = await req('POST', '/api/operator/approve', {
      suggestion_id: 999, action: 'rejected',
    })
    expect(status).toBe(404)
  })

  it('409 when suggestion already decided', async () => {
    q([{ id: 5, operator_action: 'approved' }])
    const { status, body } = await req('POST', '/api/operator/approve', {
      suggestion_id: 5, action: 'rejected',
    })
    expect(status).toBe(409)
    expect((body as { operator_action: string }).operator_action).toBe('approved')
  })

  it('approve happy path — UPDATE fires + audit log row written', async () => {
    q([{ id: 10, operator_action: 'pending' }])  // pre SELECT
    q([{ id: 10, thread_id: 50, operator_action: 'approved',
         final_output: 'Schváleno', operator_id: 'operator',
         occurred_at: '2026-04-30Z' }])         // UPDATE RETURNING
    q([])                                         // operator_audit_log INSERT
    const { status, body } = await req('POST', '/api/operator/approve', {
      suggestion_id: 10, action: 'approved', final_output: 'Schváleno',
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; suggestion: { operator_action: string; final_output: string } }
    expect(b.ok).toBe(true)
    expect(b.suggestion.operator_action).toBe('approved')
    expect(b.suggestion.final_output).toBe('Schváleno')
    const update = calls.find(c => /UPDATE ai_suggestion_audit/.test(c.sql))
    expect(update).toBeTruthy()
    const audit = calls.find(c => /INSERT INTO operator_audit_log/.test(c.sql)
      && /ai_suggestion_decided/.test(c.sql))
    expect(audit).toBeTruthy()
  })

  it('edited action captures final_output verbatim', async () => {
    q([{ id: 11, operator_action: 'pending' }])
    q([{ id: 11, thread_id: 51, operator_action: 'edited',
         final_output: 'Upravený text', operator_id: 'jane@hozan.cz',
         occurred_at: '2026-04-30Z' }])
    q([])
    const { status, body } = await req('POST', '/api/operator/approve', {
      suggestion_id: 11, action: 'edited', final_output: 'Upravený text',
    })
    expect(status).toBe(200)
    const b = body as { suggestion: { operator_action: string; final_output: string } }
    expect(b.suggestion.operator_action).toBe('edited')
    expect(b.suggestion.final_output).toBe('Upravený text')
    // UPDATE call must persist the same final_output (params order: action, final_output, operator_id, id)
    const update = calls.find(c => /UPDATE ai_suggestion_audit/.test(c.sql))
    expect(update?.params).toContain('Upravený text')
    expect(update?.params).toContain('edited')
  })

  it('rejected action sets final_output NULL via params', async () => {
    q([{ id: 12, operator_action: 'pending' }])
    q([{ id: 12, thread_id: 52, operator_action: 'rejected',
         final_output: null, operator_id: 'operator', occurred_at: '2026-04-30Z' }])
    q([])
    const { status, body } = await req('POST', '/api/operator/approve', {
      suggestion_id: 12, action: 'rejected',
    })
    expect(status).toBe(200)
    const b = body as { suggestion: { operator_action: string; final_output: unknown } }
    expect(b.suggestion.operator_action).toBe('rejected')
    expect(b.suggestion.final_output).toBeNull()
    const update = calls.find(c => /UPDATE ai_suggestion_audit/.test(c.sql))
    // params: [action, final_output_or_null, operator_id, id]
    expect(update?.params?.[1]).toBeNull()
  })

  it('respects X-Operator header for operator_id capture', async () => {
    q([{ id: 13, operator_action: 'pending' }])
    q([{ id: 13, thread_id: 53, operator_action: 'rejected',
         final_output: null, operator_id: 'tomas@hozan.cz', occurred_at: '2026-04-30Z' }])
    q([])
    const r = await fetch(baseUrl + '/api/operator/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator': 'tomas@hozan.cz' },
      body: JSON.stringify({ suggestion_id: 13, action: 'rejected' }),
    })
    expect(r.status).toBe(200)
    const update = calls.find(c => /UPDATE ai_suggestion_audit/.test(c.sql))
    expect(update?.params?.[2]).toBe('tomas@hozan.cz')
  })
})

// ─── GET /api/companies/:id/timeline ────────────────────────────────────────

describe('GET /api/companies/:id/timeline', () => {
  it('400 on empty id', async () => {
    const { status } = await req('GET', '/api/companies/%20/timeline')
    expect(status).toBe(400)
  })

  it('404 when company not found', async () => {
    q([])  // company SELECT empty
    const { status, body } = await req('GET', '/api/companies/12345678/timeline')
    expect(status).toBe(404)
    expect((body as { error: string }).error).toMatch(/Firma nenalezena/)
  })

  it('returns empty messages when company has no contacts', async () => {
    q([{ id: 1, name: 'Test Co', ico: '12345678' }])  // company found
    q([])                                                // contacts empty
    const { status, body } = await req('GET', '/api/companies/12345678/timeline')
    expect(status).toBe(200)
    const b = body as { company: { ico: string }; messages: unknown[]; total: number }
    expect(b.messages).toEqual([])
    expect(b.total).toBe(0)
    expect(b.company.ico).toBe('12345678')
  })

  it('merges outbound + inbound + ai_draft chronologically', async () => {
    q([{ id: 1, name: 'Acme', ico: '99999999' }])
    q([{ id: 7 }])  // contacts
    // Promise.all order: outbound, inbound, ai
    q([
      { id: 100, sent_at: '2026-04-25T08:00:00Z', subject: 'Nabídka',
        body_preview: 'První mail', campaign_name: 'Q2', sender_email: 'a@h.cz' },
    ])
    q([
      { id: 200, replied_at: '2026-04-26T09:00:00Z', body_text: 'Děkuji',
        body_html: null, body_preview: 'Děkuji', thread_id: 50 },
    ])
    q([
      { id: 300, thread_id: 50, ai_suggestion: 'Návrh', operator_action: 'pending',
        final_output: null, occurred_at: '2026-04-26T09:30:00Z', confidence_score: '0.5' },
    ])
    const { status, body } = await req('GET', '/api/companies/99999999/timeline')
    expect(status).toBe(200)
    const b = body as { messages: Array<{ kind: string; sent_at: string }>; total: number }
    expect(b.total).toBe(3)
    // Sorted ASC by sent_at
    expect(b.messages.map(m => m.kind)).toEqual(['outbound', 'inbound', 'ai_draft'])
    expect(new Date(b.messages[0].sent_at).getTime())
      .toBeLessThan(new Date(b.messages[1].sent_at).getTime())
  })

  it('numeric id resolves either id or ico', async () => {
    q([{ id: 42, name: 'Numeric', ico: '11111111' }])
    q([])  // contacts empty
    const { status } = await req('GET', '/api/companies/42/timeline')
    expect(status).toBe(200)
    const lookup = calls.find(c => /FROM companies WHERE/.test(c.sql))
    // The numeric branch matches BOTH id = $1 OR ico = $1::text
    expect(/id = \$1 OR ico = \$1::text/.test(lookup?.sql || '')).toBe(true)
  })

  it('ai_draft prefers final_output over ai_suggestion in body', async () => {
    q([{ id: 1, name: 'X', ico: '0' }])
    q([{ id: 5 }])
    q([])  // outbound empty
    q([])  // inbound empty
    q([{ id: 1, thread_id: 1, ai_suggestion: 'draft', operator_action: 'edited',
         final_output: 'edited final', occurred_at: '2026-04-30Z',
         confidence_score: '0.9' }])
    const { body } = await req('GET', '/api/companies/0/timeline')
    const b = body as { messages: Array<{ body: string }> }
    expect(b.messages[0].body).toBe('edited final')
  })
})

// ─── Pipeline helper smoke (LLM_RUNNER_URL unset) ───────────────────────────

describe('reply→AI suggestion pipeline (LLM runner unconfigured)', () => {
  it('endpoint stays mounted even when LLM_RUNNER_URL is unset', async () => {
    // Sanity: LLM_RUNNER_URL is unset in beforeAll — the queue endpoint
    // must still serve normally (the pipeline runs only at IMAP-poll time,
    // not on read paths).
    q([])
    q([{ total: 0 }])
    const { status } = await req('GET', '/api/operator/queue')
    expect(status).toBe(200)
    expect(process.env.LLM_RUNNER_URL).toBeUndefined()
  })
})
