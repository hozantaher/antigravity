// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/templates + /api/templates/ranking + CRUD
//
// Locks the email-template CRUD surface that's exercised by:
//   - Campaigns.jsx (NewCampaignModal step sequence template selector)
//   - Templates.jsx (CRUD page)
//   - Analytics (template ranking widget)
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
      const self = this
      return {
        async query(s, p) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(typeof s === 'string' ? s : '')) return { rows: [], rowCount: 0 }
          return self.query(s, p)
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
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

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/templates
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/templates', () => {
  it('200 with list directly (not wrapped)', async () => {
    const rows = [{ id: 1, name: 'initial', subject: 'Hello', body: 'text' }]
    queueRows(rows)
    const res = await req('GET', '/api/templates')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(rows)
  })

  it('200 with [] when no rows', async () => {
    queueRows([])
    const res = await req('GET', '/api/templates')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('500 with {error} on pg throw', async () => {
    queueError('db down')
    const res = await req('GET', '/api/templates')
    expect(res.status).toBe(500)
  })

  it('ORDER BY created_at DESC (newest first)', async () => {
    queueRows([])
    await req('GET', '/api/templates')
    expect(calls[0].sql).toMatch(/ORDER BY created_at DESC/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/templates/ranking
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/templates/ranking', () => {
  it('200 with {ranking:[...]} wrapper', async () => {
    const rows = [{ template_id: 1, name: 'initial', campaigns_used: 3, total_sent: 120, reply_rate: 5.2, open_rate: 45.0 }]
    queueRows(rows)
    const res = await req('GET', '/api/templates/ranking')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ranking: rows })
  })

  it('200 with empty ranking when no templates', async () => {
    queueRows([])
    const res = await req('GET', '/api/templates/ranking')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ranking: [] })
  })

  // Post-2026-04-30 smoke: query no longer joins reply_inbox / tracking_events.
  // Reply + open rates derived from send_events.status / opened_at directly,
  // because the auxiliary tables were the source of the LEFT JOIN failure.
  it('query reads send_events (no reply_inbox / tracking_events joins)', async () => {
    queueRows([])
    await req('GET', '/api/templates/ranking')
    expect(calls[0].sql).toMatch(/send_events/)
    expect(calls[0].sql).not.toMatch(/reply_inbox/)
    expect(calls[0].sql).not.toMatch(/tracking_events/)
  })

  it('reply_rate derived from se.status = replied', async () => {
    queueRows([])
    await req('GET', '/api/templates/ranking')
    expect(calls[0].sql).toMatch(/se\.status\s*=\s*'replied'/)
  })

  // open_rate is now hardcoded `0 AS open_rate` — open-pixel tracking was
  // removed (AR2) and there is no se.opened_at column anymore
  // (templates.js:74 + comment lines 62-64).
  it('open_rate hardcoded 0 (open-pixel tracking removed — no se.opened_at)', async () => {
    queueRows([])
    await req('GET', '/api/templates/ranking')
    expect(calls[0].sql).toMatch(/0\s+AS\s+open_rate/i)
    expect(calls[0].sql).not.toMatch(/se\.opened_at/i)
  })

  it('ranks by reply_rate DESC', async () => {
    queueRows([])
    await req('GET', '/api/templates/ranking')
    expect(calls[0].sql).toMatch(/ORDER BY reply_rate DESC/i)
  })

  it('falls back to templates-only listing when join query fails', async () => {
    // 1st call (joined query) throws → handler retries with bare list.
    queueError('relation "send_events" does not exist')
    queueRows([
      { template_id: 7, name: 'fallback', campaigns_used: 0, total_sent: 0, reply_rate: 0, open_rate: 0 },
    ])
    const res = await req('GET', '/api/templates/ranking')
    expect(res.status).toBe(200)
    expect((res.body as any).degraded).toBe(true)
    expect((res.body as any).ranking).toHaveLength(1)
    expect((res.body as any).ranking[0]).toMatchObject({ template_id: 7, name: 'fallback' })
  })

  it('500 only when both primary and fallback queries fail', async () => {
    queueError('timeout')   // primary
    queueError('timeout')   // fallback
    const res = await req('GET', '/api/templates/ranking')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/templates
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/templates', () => {
  // Compliance gate INVERTED 2026-05-07 (templates.js:116-122 bodyHasNoUnsubLink):
  // a COMPLIANT body MUST NOT contain a clickable unsub link — opt-out is via
  // reply + STOP keyword. A body with /unsubscribe, {{unsubscribe_url}} or
  // {{.UnsubURL}} is now rejected 400 compliance_unsub_link_forbidden.
  const COMPLIANT_BODY = 'Hi {{first_name}}, reply STOP to opt out.'

  it('200 returns inserted row', async () => {
    queueRows([{ id: 42, name: 'Foo', subject: 'S', body: COMPLIANT_BODY }])
    const res = await req('POST', '/api/templates', { name: 'Foo', subject: 'S', body: COMPLIANT_BODY })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 42, name: 'Foo' })
  })

  it('defaults subject to empty string when omitted', async () => {
    queueRows([{ id: 1 }])
    await req('POST', '/api/templates', { name: 'x' })
    const params = calls[0].params as unknown[]
    expect(params[1]).toBe('')
  })

  it('defaults body to empty string when omitted (empty body = draft, allowed)', async () => {
    queueRows([{ id: 1 }])
    await req('POST', '/api/templates', { name: 'x' })
    const params = calls[0].params as unknown[]
    expect(params[2]).toBe('')
  })

  it('500 on pg throw', async () => {
    queueError('unique violation')
    const res = await req('POST', '/api/templates', { name: 'dup', body: COMPLIANT_BODY })
    expect(res.status).toBe(500)
  })

  it('400 on invalid JSON', async () => {
    const res = await req('POST', '/api/templates', 'not json')
    expect(res.status).toBe(400)
  })

  // ── Compliance gate (inverted 2026-05-07: HARD RULE feedback_no_unsub_url_in_body) ──
  // Body MUST NOT contain clickable unsub link. Opt-out via reply + STOP keyword.
  it('200 when body has no unsub link (plain body — required state)', async () => {
    queueRows([{ id: 1 }])
    const res = await req('POST', '/api/templates', { name: 'plain', body: 'Just a plain body without any link.' })
    expect(res.status).toBe(200)
  })

  it('400 compliance_unsub_link_forbidden when body uses {{unsubscribe_url}} merge tag', async () => {
    const res = await req('POST', '/api/templates', { name: 'mergeUnsub', body: 'See {{unsubscribe_url}} to opt out.' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('compliance_unsub_link_forbidden')
  })

  it('400 compliance_unsub_link_forbidden when body uses {{.UnsubURL}} Go-flavoured tag', async () => {
    const res = await req('POST', '/api/templates', { name: 'goUnsub', body: 'Footer: {{.UnsubURL}}' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('compliance_unsub_link_forbidden')
  })

  it('400 compliance_unsub_link_forbidden when body has literal /unsubscribe URL', async () => {
    const res = await req('POST', '/api/templates', { name: 'literalUnsub', body: 'Click https://garaaage.cz/unsubscribe?c=1&id=2 to opt out.' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('compliance_unsub_link_forbidden')
  })

  it('200 when body has misspelled merge tag (typo — bypasses gate, not flagged)', async () => {
    queueRows([{ id: 4 }])
    const res = await req('POST', '/api/templates', { name: 'typo', body: 'See {{unsubcribe_url}} (typo)' })
    expect(res.status).toBe(200)
  })

  it('200 when body has /unsub but not /unsubscribe (no partial match either way)', async () => {
    queueRows([{ id: 5 }])
    const res = await req('POST', '/api/templates', { name: 'partial', body: 'See /unsub for help.' })
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PUT /api/templates/:id
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/templates/:id', () => {
  // Compliance gate inverted (2026-05-07): COMPLIANT body has NO unsub link.
  const COMPLIANT_BODY = 'Hi {{first_name}}, reply STOP to opt out.'

  it('200 returns updated row', async () => {
    queueRows([{ id: 7, name: 'Updated', subject: 'NewS', body: COMPLIANT_BODY }])
    const res = await req('PUT', '/api/templates/7', { name: 'Updated', subject: 'NewS', body: COMPLIANT_BODY })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 7, name: 'Updated' })
  })

  it('defaults subject+body to empty string', async () => {
    queueRows([{ id: 7 }])
    await req('PUT', '/api/templates/7', { name: 'x' })
    const params = calls[0].params as unknown[]
    expect(params[1]).toBe('')
    expect(params[2]).toBe('')
  })

  it('500 on pg throw', async () => {
    queueError('lock timeout')
    const res = await req('PUT', '/api/templates/7', { name: 'x' })
    expect(res.status).toBe(500)
  })

  it('400 compliance_unsub_link_forbidden when updated body has unsub link (HARD RULE)', async () => {
    const res = await req('PUT', '/api/templates/7', { name: 'x', body: 'See {{.UnsubURL}} to opt out.' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('compliance_unsub_link_forbidden')
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/templates/:id
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/templates/:id', () => {
  it('200 {ok:true} on success', async () => {
    // DELETE now runs a pre-SELECT existence/audit fetch before the DELETE
    // (templates.js:269) — feed it a row so the 404 branch is skipped.
    queueRows([{ id: 7, name: 'x', subject: 'y' }])
    const res = await req('DELETE', '/api/templates/7')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('issues DELETE with id param', async () => {
    // pre-SELECT existence row (templates.js:269) is now calls[0]; the DELETE
    // is a later query — match it by SQL instead of a fixed index.
    queueRows([{ id: 7, name: 'x', subject: 'y' }])
    await req('DELETE', '/api/templates/7')
    const del = calls.find((c) => /DELETE FROM email_templates/i.test(c.sql))
    expect(del).toBeTruthy()
    expect(del!.params).toEqual(['7'])
  })

  it('500 on FK violation (template referenced by campaign)', async () => {
    queueError('fk constraint')
    const res = await req('DELETE', '/api/templates/7')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/templates — extended scenarios
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/templates (extended)', () => {
  it('returns array of templates with expected shape', async () => {
    const rows = [
      { id: 1, name: 'initial', subject: 'Hello {{name}}', body: 'Body text', created_at: '2026-04-01' },
      { id: 2, name: 'followup1', subject: 'Follow-up', body: 'Follow body', created_at: '2026-04-02' },
    ]
    queueRows(rows)
    const res = await req('GET', '/api/templates')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect((res.body as unknown[]).length).toBe(2)
    const first = (res.body as any[])[0]
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('name')
    expect(first).toHaveProperty('subject')
    expect(first).toHaveProperty('body')
  })

  it('empty DB → returns []', async () => {
    queueRows([])
    const res = await req('GET', '/api/templates')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('DB error → 500 with {error}', async () => {
    queueError('pg connection refused')
    const res = await req('GET', '/api/templates')
    expect(res.status).toBe(500)
    expect((res.body as any).error).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/templates (create) — extended scenarios
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/templates (create extended)', () => {
  it('valid → 200 with inserted row', async () => {
    // Inverted compliance gate (templates.js:116-122): body must NOT carry an
    // unsub link; opt-out is reply + STOP. A {{unsubscribe_url}} body now 400s.
    const body = 'Content here. Reply STOP to opt out.'
    queueRows([{ id: 55, name: 'Newsletter', subject: 'Weekly digest', body }])
    const res = await req('POST', '/api/templates', { name: 'Newsletter', subject: 'Weekly digest', body })
    expect(res.status).toBe(200)
    expect((res.body as any).id).toBe(55)
    expect((res.body as any).name).toBe('Newsletter')
  })

  it('missing name → 400 with {error}', async () => {
    const res = await req('POST', '/api/templates', { subject: 'No name here', body: 'Some body' })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toBeTruthy()
  })

  it('empty name string → 400', async () => {
    const res = await req('POST', '/api/templates', { name: '', subject: 'Sub', body: 'Body' })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toBeTruthy()
  })

  it('non-string name → 400', async () => {
    const res = await req('POST', '/api/templates', { name: 42, subject: 'Sub' })
    expect(res.status).toBe(400)
    expect((res.body as any).error).toBeTruthy()
  })

  it('DB error → 500', async () => {
    queueError('unique_violation: name')
    const res = await req('POST', '/api/templates', { name: 'dup-template' })
    expect(res.status).toBe(500)
    expect((res.body as any).error).toBeTruthy()
  })

  it('MONKEY: 8 template payload variants never crash server', async () => {
    const monkeyPayloads = [
      null,
      '',
      42,
      [],
      { name: null },
      { name: [] },
      { subject: 'no-name', body: 'no-name' },
      { name: true, subject: 'bool name' },
    ]

    for (const payload of monkeyPayloads) {
      // Pre-queue a DB error in case validation passes unexpectedly
      queueError('monkey template stub')

      const bodyStr = payload === '' ? '' : JSON.stringify(payload)
      const r = await fetch(baseUrl + '/api/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyStr,
      })
      const text = await r.text()
      let json: unknown = null
      try { json = text ? JSON.parse(text) : null } catch { json = text }
      const res = { status: r.status, body: json }

      // Server must not crash — always returns valid HTTP
      expect(res.status, `template POST payload ${JSON.stringify(payload)} → invalid status`).toBeGreaterThanOrEqual(200)
      expect(res.status, `template POST payload ${JSON.stringify(payload)} → invalid status`).toBeLessThan(600)
      // All these payloads lack a valid string name → must be 4xx (now with server-side validation)
      expect(res.status, `template POST payload ${JSON.stringify(payload)} must not be 2xx`).not.toBeLessThan(400)
    }
  })
})
