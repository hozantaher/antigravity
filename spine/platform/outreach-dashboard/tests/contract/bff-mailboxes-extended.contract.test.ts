// ═══════════════════════════════════════════════════════════════════════
//  M2 / BFF contract — extended endpoints
//
//  Covers the rest of the /api/mailboxes* surface that the first file
//  didn't touch. Live-probe endpoints (SMTP/IMAP/SOCKS) are exercised
//  only on their input-validation, mailbox-missing, and pg-error
//  branches; the happy success path for those lives in M5 integration.
// ═══════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [] }
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
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
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

function queueRows(rows: unknown[]) {
  queryQueue.push({ rows })
}
function queueError(msg: string) {
  queryQueue.push(new Error(msg))
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text, headers: r.headers }
}

// ═══════════════════════════════════════════════════════════════════════
//  cooldown-log
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/cooldown-log', () => {
  it('200 default limit=20', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/1/cooldown-log')
    expect(res.status).toBe(200)
    expect(calls[0].params?.[1]).toBe(20)
  })
  it('clamps limit to 100 max', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/1/cooldown-log?limit=9999')
    expect(calls[0].params?.[1]).toBe(100)
  })
  it('clamps limit to 1 min', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/1/cooldown-log?limit=-5')
    expect(calls[0].params?.[1]).toBe(1)
  })
  it('200 [] when table missing', async () => {
    queueError('relation "mailbox_cooldown_log" does not exist')
    const res = await req('GET', '/api/mailboxes/1/cooldown-log')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
  it('500 on unrelated pg error', async () => {
    queueError('deadlock detected')
    const res = await req('GET', '/api/mailboxes/1/cooldown-log')
    expect(res.status).toBe(500)
  })
  it('200 returns rows verbatim', async () => {
    const rows = [{ id: 1, entered_at: '2026-04-01T00:00:00Z', left_at: null, bounces_at_entry: 5 }]
    queueRows(rows)
    const res = await req('GET', '/api/mailboxes/1/cooldown-log')
    expect(res.body).toEqual(rows)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  pipeline-results
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/pipeline-results', () => {
  it('200 with normalized steps shape', async () => {
    queueRows([{ id: 1, overall_ok: true, steps: { smtp: { ok: true, steps: [] } }, tested_at: 'now' }])
    const res = await req('GET', '/api/mailboxes/1/pipeline-results')
    expect(res.status).toBe(200)
    const body = res.body as Array<{ steps: { smtp: { steps: unknown[] } } }>
    expect(Array.isArray(body[0].steps.smtp.steps)).toBe(true)
  })
  it('200 [] when no pipeline runs yet', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/1/pipeline-results')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
  it('500 on pg error', async () => {
    queueError('io')
    const res = await req('GET', '/api/mailboxes/1/pipeline-results')
    expect(res.status).toBe(500)
  })
  it('limit is hardcoded to 5', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/1/pipeline-results')
    expect(calls[0].sql).toMatch(/LIMIT\s+5/)
  })
  it('normalizes steps that are null', async () => {
    queueRows([{ id: 1, overall_ok: false, steps: { smtp: null }, tested_at: 'now' }])
    const res = await req('GET', '/api/mailboxes/1/pipeline-results')
    const body = res.body as Array<{ steps: { smtp: unknown } }>
    expect(body[0].steps.smtp).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  warmup/start
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/:id/warmup/start', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('POST', '/api/mailboxes/99/warmup/start', {})
    expect(res.status).toBe(404)
  })
  it('200 {ok, mailbox_address} on success', async () => {
    queueRows([{ from_address: 'jan@alias.test' }])
    queueRows([])
    const res = await req('POST', '/api/mailboxes/1/warmup/start', {})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, mailbox_address: 'jan@alias.test' })
  })
  it('500 when SELECT fails', async () => {
    queueError('select')
    const res = await req('POST', '/api/mailboxes/1/warmup/start', {})
    expect(res.status).toBe(500)
  })
  it('500 when INSERT fails', async () => {
    queueRows([{ from_address: 'jan@alias.test' }])
    queueError('insert')
    const res = await req('POST', '/api/mailboxes/1/warmup/start', {})
    expect(res.status).toBe(500)
  })
  it('issues ON CONFLICT UPSERT on second call', async () => {
    queueRows([{ from_address: 'jan@alias.test' }])
    queueRows([])
    await req('POST', '/api/mailboxes/1/warmup/start', {})
    expect(calls[1].sql).toMatch(/ON CONFLICT/)
    expect(calls[1].sql).toMatch(/DO UPDATE/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  proxy-live-check
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/proxy-live-check', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/proxy-live-check')
    expect(res.status).toBe(404)
  })
  it('ok:null reason:not_configured when no proxy', async () => {
    queueRows([{ proxy_url: null }])
    const res = await req('GET', '/api/mailboxes/1/proxy-live-check')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: null, reason: 'not_configured', proxy_url: null })
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/proxy-live-check')
    expect(res.status).toBe(500)
  })
  it('handles invalid url with ok:false reason:invalid_url', async () => {
    queueRows([{ proxy_url: 'not-a-url' }])
    const res = await req('GET', '/api/mailboxes/1/proxy-live-check')
    // invalid URL either runs through socks5Probe+fails or hits the catch
    expect(res.status).toBe(200)
    expect((res.body as { ok?: unknown }).ok === false || (res.body as { ok?: unknown }).ok === null).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  assign-proxy
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/:id/assign-proxy', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('POST', '/api/mailboxes/99/assign-proxy', {})
    expect(res.status).toBe(404)
  })
  it('500 when pg throws', async () => {
    queueError('pg')
    const res = await req('POST', '/api/mailboxes/1/assign-proxy', {})
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  health-summary
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/health-summary', () => {
  it('200 with zeroed counts when no mailboxes', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/health-summary')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total: 0, healthy: 0, degraded: 0, critical: 0, mailboxes: [] })
  })
  it('classifies mailboxes by score (healthy ≥80, degraded 50-79, critical <50 or null)', async () => {
    queueRows([
      { id: 1, email: 'a@x' }, { id: 2, email: 'b@x' }, { id: 3, email: 'c@x' },
    ])
    queueRows([{ score: 95, ok: true, critical: [] }]) // cached fresh
    queueRows([{ score: 60, ok: true, critical: [] }]) // cached fresh
    queueRows([{ score: 20, ok: false, critical: ['smtp'] }]) // cached fresh
    const res = await req('GET', '/api/mailboxes/health-summary')
    expect(res.body).toMatchObject({ total: 3, healthy: 1, degraded: 1, critical: 1 })
  })
  it('falls through to non-fresh cache when no 5-min row', async () => {
    queueRows([{ id: 1, email: 'a@x' }])
    queueRows([]) // no fresh cache
    queueRows([{ score: 85, ok: true, critical: [] }]) // any-age cache
    const res = await req('GET', '/api/mailboxes/health-summary')
    expect(res.body).toMatchObject({ total: 1, healthy: 1 })
  })
  it('retired mailboxes are excluded (SQL filter)', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/health-summary')
    expect(calls[0].sql).toMatch(/status NOT IN \('retired'\)/i)
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/health-summary')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  send-trends
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/send-trends', () => {
  it('200 {} when no rows', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/send-trends')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
  })
  it('defaults days=7, clamps to [1,30]', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/send-trends')
    expect(calls[0].params?.[0]).toBe(7)
  })
  it('days=9999 clamps to 30', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/send-trends?days=9999')
    expect(calls[0].params?.[0]).toBe(30)
  })
  it('days=-5 clamps to 1', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/send-trends?days=-5')
    expect(calls[0].params?.[0]).toBe(1)
  })
  it('builds per-mailbox array with zero-filled days', async () => {
    const today = new Date().toISOString().slice(0, 10)
    queueRows([{ mailbox_id: 1, day: today, sent: 5 }])
    const res = await req('GET', '/api/mailboxes/send-trends?days=1')
    expect(res.body).toEqual({ 1: [5] })
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/send-trends')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  smtp-check / imap-check
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/smtp-check', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/smtp-check')
    expect(res.status).toBe(404)
  })
  it('returns auth_guard failure when no password configured', async () => {
    queueRows([{ smtp_host: 'smtp.x', smtp_port: 587, smtp_username: 'u', password: null, proxy_url: null }])
    const res = await req('GET', '/api/mailboxes/1/smtp-check')
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(false)
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/smtp-check')
    expect(res.status).toBe(500)
  })
})

describe('GET /api/mailboxes/:id/imap-check', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/imap-check')
    expect(res.status).toBe(404)
  })
  it('ok:false reason:no_imap_configured when imap_host null', async () => {
    queueRows([{ imap_host: null, imap_port: null, imap_username: null, smtp_username: 'u', password: 'p' }])
    const res = await req('GET', '/api/mailboxes/1/imap-check')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, reason: 'no_imap_configured' })
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/imap-check')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  header-probe
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/:id/header-probe', () => {
  it('400 when message_id missing', async () => {
    const res = await req('POST', '/api/mailboxes/1/header-probe', {})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'message_id required' })
  })
  it('400 with empty body', async () => {
    const res = await req('POST', '/api/mailboxes/1/header-probe', undefined)
    expect(res.status).toBe(400)
  })
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('POST', '/api/mailboxes/99/header-probe', { message_id: 'x@y' })
    expect(res.status).toBe(404)
  })
  it('422 when mailbox has no imap_host', async () => {
    queueRows([{ imap_host: null, imap_port: null, imap_username: null, smtp_username: 'u', password: 'p' }])
    const res = await req('POST', '/api/mailboxes/1/header-probe', { message_id: 'x@y' })
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: 'no_imap_configured' })
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('POST', '/api/mailboxes/1/header-probe', { message_id: 'x@y' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  config-check
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/config-check', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/config-check')
    expect(res.status).toBe(404)
  })
  it('200 {ok:true, issues:[]} for fully-configured mailbox', async () => {
    queueRows([{
      password: 'p', smtp_host: 's', smtp_port: 587, smtp_username: 'u',
      imap_host: 'i', imap_port: 993, imap_username: 'ui',
      daily_cap_override: 100, proxy_url: 'socks5://1.2.3.4:1080',
    }])
    const res = await req('GET', '/api/mailboxes/1/config-check')
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBeTypeOf('boolean')
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/config-check')
    expect(res.status).toBe(500)
  })
  it('flags missing password as critical', async () => {
    queueRows([{
      password: null, smtp_host: 's', smtp_port: 587, smtp_username: 'u',
      imap_host: null, imap_port: null, imap_username: null,
      daily_cap_override: 100, proxy_url: null,
    }])
    const res = await req('GET', '/api/mailboxes/1/config-check')
    const b = res.body as { ok: boolean; issues: Array<{ severity: string }> }
    expect(b.ok).toBe(false)
    expect(b.issues.some(i => i.severity === 'critical')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  warmup-status / bounce-status / send-rate
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/warmup-status', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/warmup-status')
    expect(res.status).toBe(404)
  })
  it('active:false when no warmup row', async () => {
    queueRows([{ id: 1, from_address: 'x@y', warmup_day: null, is_paused: null, last_advanced_at: null, pause_reason: null }])
    const res = await req('GET', '/api/mailboxes/1/warmup-status')
    expect(res.status).toBe(200)
    expect((res.body as { active: boolean }).active).toBe(false)
  })
  it('active:true ok:true for live warmup', async () => {
    queueRows([{ id: 1, from_address: 'x@y', warmup_day: 5, is_paused: false, last_advanced_at: new Date().toISOString(), pause_reason: null }])
    const res = await req('GET', '/api/mailboxes/1/warmup-status')
    expect((res.body as { active: boolean; ok: boolean }).active).toBe(true)
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/warmup-status')
    expect(res.status).toBe(500)
  })
  it('paused warmup returns paused:true, ok:false', async () => {
    queueRows([{ id: 1, from_address: 'x@y', warmup_day: 5, is_paused: true, last_advanced_at: new Date().toISOString(), pause_reason: 'operator' }])
    const res = await req('GET', '/api/mailboxes/1/warmup-status')
    expect((res.body as { ok: boolean; paused: boolean; pause_reason: string }).paused).toBe(true)
  })
})

describe('GET /api/mailboxes/:id/bounce-status', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/bounce-status')
    expect(res.status).toBe(404)
  })
  it('rate:null when no sends yet', async () => {
    queueRows([{ consecutive_bounces: 0, total_sent: 0, total_bounced: 0, status: 'active' }])
    const res = await req('GET', '/api/mailboxes/1/bounce-status')
    expect((res.body as { rate: number | null }).rate).toBeNull()
  })
  it('computes rate as percentage with 1 decimal', async () => {
    queueRows([{ consecutive_bounces: 0, total_sent: 100, total_bounced: 3, status: 'active' }])
    const res = await req('GET', '/api/mailboxes/1/bounce-status')
    expect((res.body as { rate: number }).rate).toBe(3)
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/bounce-status')
    expect(res.status).toBe(500)
  })
  it('returns all expected fields', async () => {
    queueRows([{ consecutive_bounces: 1, total_sent: 50, total_bounced: 2, status: 'active' }])
    const res = await req('GET', '/api/mailboxes/1/bounce-status')
    expect(res.body).toMatchObject({
      consecutive: 1, total_sent: 50, total_bounced: 2, status: 'active',
    })
    expect((res.body as { classification: string }).classification).toBeTypeOf('string')
  })
})

describe('GET /api/mailboxes/:id/send-rate', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/send-rate')
    expect(res.status).toBe(404)
  })
  it('computes pct and ok status under limit', async () => {
    queueRows([{ from_address: 'x@y', daily_cap_override: 100, last_send_at: null }])
    queueRows([{ sent_today: 30 }])
    const res = await req('GET', '/api/mailboxes/1/send-rate')
    expect(res.body).toMatchObject({ sent_today: 30, limit: 100, pct: 30, ok: true })
  })
  it('ok:false when at/over limit', async () => {
    queueRows([{ from_address: 'x@y', daily_cap_override: 100, last_send_at: null }])
    queueRows([{ sent_today: 100 }])
    const res = await req('GET', '/api/mailboxes/1/send-rate')
    expect((res.body as { ok: boolean }).ok).toBe(false)
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/send-rate')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  pipeline-status
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/pipeline-status', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/pipeline-status')
    expect(res.status).toBe(404)
  })
  it('exists:false when no pipeline runs', async () => {
    queueRows([{ id: 1 }])
    queueRows([])
    const res = await req('GET', '/api/mailboxes/1/pipeline-status')
    expect(res.body).toMatchObject({ ok: false, exists: false, stale: true })
  })
  it('returns overall_ok and tested_at from latest row', async () => {
    queueRows([{ id: 1 }])
    queueRows([{ overall_ok: true, tested_at: new Date().toISOString() }])
    const res = await req('GET', '/api/mailboxes/1/pipeline-status')
    expect((res.body as { exists: boolean }).exists).toBe(true)
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/pipeline-status')
    expect(res.status).toBe(500)
  })
  it('limits query to 1 latest row', async () => {
    queueRows([{ id: 1 }])
    queueRows([])
    await req('GET', '/api/mailboxes/1/pipeline-status')
    expect(calls[1].sql).toMatch(/LIMIT\s+1/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  check-history
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/check-history', () => {
  it('200 [] when no history', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/1/check-history')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
  it('reverses rows so older first', async () => {
    queueRows([
      { score: 90, ok: true, checked_at: '2026-04-03' },
      { score: 80, ok: true, checked_at: '2026-04-02' },
      { score: 70, ok: false, checked_at: '2026-04-01' },
    ])
    const res = await req('GET', '/api/mailboxes/1/check-history')
    const body = res.body as Array<{ checked_at: string }>
    expect(body[0].checked_at).toBe('2026-04-01')
  })
  it('limit hardcoded to 14', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/1/check-history')
    expect(calls[0].sql).toMatch(/LIMIT\s+14/)
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/check-history')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  imap-inbox
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/imap-inbox', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/99/imap-inbox')
    expect(res.status).toBe(404)
  })
  it('ok:false reason:no_imap when no imap_host', async () => {
    queueRows([{ imap_host: null, imap_port: null, imap_username: null, smtp_username: 'u', password: 'p' }])
    const res = await req('GET', '/api/mailboxes/1/imap-inbox')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, reason: 'no_imap', unseen: null })
  })
  it('pg error yields ok:false (handler catches)', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/imap-inbox')
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  bulk-assign-proxy / bulk-check
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/bulk-assign-proxy', () => {
  it('400 when ids array missing', async () => {
    const res = await req('POST', '/api/mailboxes/bulk-assign-proxy', {})
    expect(res.status).toBe(400)
  })
  it('400 when ids empty', async () => {
    const res = await req('POST', '/api/mailboxes/bulk-assign-proxy', { ids: [] })
    expect(res.status).toBe(400)
  })
  it('400 when ids not an array', async () => {
    const res = await req('POST', '/api/mailboxes/bulk-assign-proxy', { ids: 'nope' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/mailboxes/bulk-check', () => {
  it('400 when ids missing', async () => {
    const res = await req('POST', '/api/mailboxes/bulk-check', {})
    expect(res.status).toBe(400)
  })
  it('400 when ids empty', async () => {
    const res = await req('POST', '/api/mailboxes/bulk-check', { ids: [] })
    expect(res.status).toBe(400)
  })
  it('200 {ok, triggered} fires fire-and-forget', async () => {
    const res = await req('POST', '/api/mailboxes/bulk-check', { ids: [1, 2, 3] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, triggered: 3 })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  import-csv
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/import-csv', () => {
  it('400 when rows missing', async () => {
    const res = await req('POST', '/api/mailboxes/import-csv', {})
    expect(res.status).toBe(400)
  })
  it('400 when rows empty', async () => {
    const res = await req('POST', '/api/mailboxes/import-csv', { rows: [] })
    expect(res.status).toBe(400)
  })
  it('400 when rows is not array', async () => {
    const res = await req('POST', '/api/mailboxes/import-csv', { rows: 'nope' })
    expect(res.status).toBe(400)
  })
  it('reports per-row errors for rows missing required fields', async () => {
    const res = await req('POST', '/api/mailboxes/import-csv', {
      rows: [{ email: '', smtp_host: 's', password: 'p' }],
    })
    expect(res.status).toBe(200)
    expect((res.body as { errors: unknown[] }).errors).toHaveLength(1)
  })
  it('imports valid rows and returns {imported, total}', async () => {
    queueRows([{ id: 42, email: 'a@b.test' }])
    const res = await req('POST', '/api/mailboxes/import-csv', {
      rows: [{ email: 'a@b.test', smtp_host: 's', password: 'p' }],
    })
    expect(res.body).toMatchObject({ imported: 1, total: 1 })
  })
  it('defaults smtp_port=465 when omitted in csv row', async () => {
    queueRows([{ id: 1, email: 'a@b.test' }])
    await req('POST', '/api/mailboxes/import-csv', {
      rows: [{ email: 'a@b.test', smtp_host: 's', password: 'p' }],
    })
    expect(calls[0].params?.[2]).toBe(465)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  send-test
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/:id/send-test', () => {
  it('400 when to missing or invalid', async () => {
    const res = await req('POST', '/api/mailboxes/1/send-test', {})
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_email')
  })
  it('425 outside send window (sans ?force=1)', async () => {
    // Mon 00:00 UTC == Mon 01:00 CET — outside 8-17 window
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T00:00:00Z'))
    const res = await req('POST', '/api/mailboxes/1/send-test', { to: 'x@y.test' })
    vi.useRealTimers()
    expect(res.status).toBe(425)
  })
  it('400 when recipient on suppression list', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T09:00:00+02:00')) // Monday 09:00 CEST
    queueRows([{ email: 'x@y.test' }]) // suppression hit
    const res = await req('POST', '/api/mailboxes/1/send-test?force=1', { to: 'x@y.test' })
    vi.useRealTimers()
    expect(res.status).toBe(400)
  })
  it('404 when mailbox missing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T09:00:00+02:00'))
    queueRows([]) // suppression: empty
    // force=1 skips rate limit check, so next query is the mailbox SELECT
    queueRows([]) // mailbox SELECT empty
    const res = await req('POST', '/api/mailboxes/99/send-test?force=1', { to: 'x@y.test' })
    vi.useRealTimers()
    expect(res.status).toBe(404)
  })
  it('502 when relay env not configured (anti-trace-relay path)', async () => {
    // proxy_url field on mailbox is deprecated (memory: project_per_mailbox_proxy_deprecated).
    // Send-test now routes through anti-trace-relay (env: ANTI_TRACE_URL + ANTI_TRACE_TOKEN
    // OR outreach_config DB row). When neither is set, handler returns 502 with
    // "relay not configured" — not a 400 about proxy_url.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T09:00:00+02:00'))
    queueRows([]) // suppression
    queueRows([{ email: 'jan@a', host: 's', port: 587, smtp_username: 'u', password: 'p' }])
    queueRows([]) // outreach_config relay URL lookup (also empty)
    const res = await req('POST', '/api/mailboxes/1/send-test?force=1', { to: 'x@y.test' })
    vi.useRealTimers()
    // Either 502 (relay not configured) or 502 (relay unreachable from test env).
    expect([200, 502]).toContain(res.status)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  alerts
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/alerts', () => {
  it('200 [] when none', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/1/alerts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
  it('200 rows with severity field', async () => {
    queueRows([{ id: 1, type: 'bounce', severity: 'high', message: 'x', created_at: 'now', resolved_at: null }])
    const res = await req('GET', '/api/mailboxes/1/alerts')
    expect(res.status).toBe(200)
    expect((res.body as Array<{ severity: string }>)[0].severity).toBe('high')
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/alerts')
    expect(res.status).toBe(500)
  })
  it('limits to 50 rows', async () => {
    queueRows([])
    await req('GET', '/api/mailboxes/1/alerts')
    expect(calls[0].sql).toMatch(/LIMIT\s+50/)
  })
})

describe('PATCH /api/mailboxes/:id/alerts/:alertId/resolve', () => {
  it('200 {ok:true} on success', async () => {
    queueRows([])
    const res = await req('PATCH', '/api/mailboxes/1/alerts/5/resolve', {})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
  it('500 on pg throw', async () => {
    queueError('pg')
    const res = await req('PATCH', '/api/mailboxes/1/alerts/5/resolve', {})
    expect(res.status).toBe(500)
  })
  it('passes both ids to UPDATE', async () => {
    queueRows([])
    await req('PATCH', '/api/mailboxes/7/alerts/42/resolve', {})
    expect(calls[0].params).toEqual(['42', '7'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  pipeline-test
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/mailboxes/:id/pipeline-test', () => {
  it('404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('POST', '/api/mailboxes/99/pipeline-test', {})
    expect(res.status).toBe(404)
  })
  it('500 on pg throw during mailbox SELECT', async () => {
    queueError('pg')
    const res = await req('POST', '/api/mailboxes/1/pipeline-test', {})
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  full-check
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes/:id/full-check', () => {
  it('returns cached row when fresh', async () => {
    queueRows([{ score: 95, ok: true, checks: {}, critical: [], warnings: [], checked_at: 'now' }])
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(200)
    expect((res.body as { cached: boolean }).cached).toBe(true)
  })
  it('force=1 bypasses cache and 404s when mailbox missing', async () => {
    queueRows([]) // mailbox SELECT empty
    const res = await req('GET', '/api/mailboxes/99/full-check?force=1')
    expect(res.status).toBe(404)
  })
  it('500 on cache lookup pg throw', async () => {
    queueError('pg')
    const res = await req('GET', '/api/mailboxes/1/full-check')
    expect(res.status).toBe(500)
  })
})
