// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — G1 extract guard for /api/mailboxes/:id/* operational routes
//
// Sprint G1 (2026-05-03) moved 12 operational/admin handlers from server.js
// into ./src/server-routes/mailboxes.js. This file pins the behavior
// contracts that survived the extract:
//
//   * Response shape preserved verbatim (stats default + canary_remaining
//     on /recover + ok:true on PATCH alerts/resolve).
//   * Password discipline (memory `feedback_mailbox_passwords_via_db` T0):
//     these endpoints NEVER echo `password` back. Critical for /recover
//     and /auth-reset which read mailbox row but only expose
//     {id, from_address, status} or {id, from_address, auth_fail_count}.
//   * Status flip behavior: /recover writes status='active' +
//     status_reason='manual_recover' regardless of prior state
//     (idempotent on already-active mailboxes).
//   * Number-coercion guards on /recover and /auth-reset reject
//     non-positive ids with HTTP 400, not 500.
//   * 404 on missing mailbox preserved on send-log/campaigns/recover/
//     auth-reset/warmup/start.
//   * "relation does not exist" graceful fallback preserved on
//     watchdog-events and cooldown-log (returns []).
//
// Heal/diagnostic routes (smtp-check, imap-check, full-check, pipeline-test,
// proxy-live-check, assign-proxy, header-probe, send-test, bulk-*,
// import-csv, anonymity-probe, health-stream, health-summary, send-trends,
// daemon control) stay in server.js — they reach into mid-file helpers
// (smtpCheck/imapCheck/relay*/assignBestProxy). Those move out in Batch B.
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
//  Stats endpoint — default fallback shape
// ═══════════════════════════════════════════════════════════════════════

describe('G1: GET /api/mailboxes/:id/stats response shape', () => {
  it('returns row when mailbox exists', async () => {
    queueRows([{ total_sent: 17, total_bounced: 1, consecutive_bounces: 0, sent_30d: 12 }])
    const res = await req('GET', '/api/mailboxes/42/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total_sent: 17, total_bounced: 1, consecutive_bounces: 0, sent_30d: 12 })
  })

  it('returns zero-default object when mailbox row missing (no 404)', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/9999/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total_sent: 0, total_bounced: 0, sent_30d: 0, consecutive_bounces: 0 })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Send-log + campaigns — 404 on missing mailbox
// ═══════════════════════════════════════════════════════════════════════

describe('G1: send-log + campaigns 404 contract', () => {
  it('GET /send-log returns 404 when mailbox not found', async () => {
    queueRows([]) // SELECT from_address ... → empty
    const res = await req('GET', '/api/mailboxes/9999/send-log')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('GET /campaigns returns 404 when mailbox not found', async () => {
    queueRows([])
    const res = await req('GET', '/api/mailboxes/9999/campaigns')
    expect(res.status).toBe(404)
  })

  it('GET /campaigns wraps response with {total, campaigns}', async () => {
    queueRows([{ from_address: 'a@b.cz' }]) // first SELECT (mb lookup)
    queueRows([{ id: 1, name: 'C1', status: 'running', sent_count: 5, last_sent_at: '2026-04-01' }])
    const res = await req('GET', '/api/mailboxes/1/campaigns')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 1, campaigns: expect.any(Array) })
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Watchdog-events + cooldown-log — graceful fallback on missing relation
// ═══════════════════════════════════════════════════════════════════════

describe('G1: graceful fallback on missing relation', () => {
  it('GET /watchdog-events returns [] when watchdog_events relation missing', async () => {
    queueError('relation "watchdog_events" does not exist')
    const res = await req('GET', '/api/mailboxes/1/watchdog-events')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('GET /cooldown-log returns [] when mailbox_cooldown_log relation missing', async () => {
    queueError('relation "mailbox_cooldown_log" does not exist')
    const res = await req('GET', '/api/mailboxes/1/cooldown-log')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('GET /watchdog-events 500 on non-relation error (not silenced)', async () => {
    queueError('connection refused')
    const res = await req('GET', '/api/mailboxes/1/watchdog-events')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Recover endpoint — id validation + status flip + canary seed
// ═══════════════════════════════════════════════════════════════════════

describe('G1: POST /api/mailboxes/:id/recover', () => {
  it('400 when id is not a positive integer (e.g. "abc")', async () => {
    const res = await req('POST', '/api/mailboxes/abc/recover', { reason: 'r' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_id' })
  })

  it('400 when id is zero', async () => {
    const res = await req('POST', '/api/mailboxes/0/recover')
    expect(res.status).toBe(400)
  })

  it('flips status to active + status_reason=manual_recover + canary_remaining=10', async () => {
    queueRows([{ id: 1, from_address: 'a@b.cz', status: 'active' }]) // UPDATE...RETURNING
    queueRows([]) // cooldown UPDATE
    queueRows([]) // watchdog INSERT
    const res = await req('POST', '/api/mailboxes/1/recover', { reason: 'manual' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      mailbox: { id: 1, from_address: 'a@b.cz', status: 'active' },
      canary_remaining: 10,
    })
    // Asserts the SQL really sets the canonical fields.
    const updateSql = calls[0].sql
    expect(updateSql).toMatch(/SET\s+status\s*=\s*'active'/i)
    expect(updateSql).toMatch(/status_reason\s*=\s*'manual_recover'/i)
    expect(updateSql).toMatch(/canary_remaining\s*=\s*\$2/i)
  })

  it('404 when UPDATE...RETURNING returns no rows', async () => {
    queueRows([])
    const res = await req('POST', '/api/mailboxes/1/recover')
    expect(res.status).toBe(404)
  })

  it('PASSWORD DISCIPLINE: response body never contains password field', async () => {
    queueRows([{ id: 1, from_address: 'a@b.cz', status: 'active' }])
    queueRows([])
    queueRows([])
    const res = await req('POST', '/api/mailboxes/1/recover')
    const bodyText = JSON.stringify(res.body)
    expect(bodyText).not.toMatch(/password/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Auth-reset — clears auth_fail_count + circuit_opened_at; password safe
// ═══════════════════════════════════════════════════════════════════════

describe('G1: POST /api/mailboxes/:id/auth-reset', () => {
  it('400 on non-numeric id', async () => {
    const res = await req('POST', '/api/mailboxes/foo/auth-reset')
    expect(res.status).toBe(400)
  })

  it('UPDATE zeroes auth_fail_count + clears circuit_opened_at', async () => {
    queueRows([{ id: 1, from_address: 'a@b.cz', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([]) // watchdog UPDATE healed
    queueRows([]) // watchdog INSERT audit row
    const res = await req('POST', '/api/mailboxes/1/auth-reset')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      mailbox: { auth_fail_count: 0, circuit_opened_at: null },
    })
    expect(calls[0].sql).toMatch(/auth_fail_count\s*=\s*0/i)
    expect(calls[0].sql).toMatch(/circuit_opened_at\s*=\s*NULL/i)
  })

  it('404 when mailbox not found', async () => {
    queueRows([])
    const res = await req('POST', '/api/mailboxes/9999/auth-reset')
    expect(res.status).toBe(404)
  })

  it('PASSWORD DISCIPLINE: never selects or echoes password column', async () => {
    queueRows([{ id: 1, from_address: 'a@b.cz', auth_fail_count: 0, circuit_opened_at: null }])
    queueRows([])
    queueRows([])
    const res = await req('POST', '/api/mailboxes/1/auth-reset')
    expect(res.status).toBe(200)
    // Neither the SQL RETURNING clause nor the JSON response leaks password.
    expect(calls[0].sql).not.toMatch(/RETURNING[^;]*password/i)
    const bodyText = JSON.stringify(res.body)
    expect(bodyText).not.toMatch(/password/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Warmup PATCH + warmup/start — status flip behavior
// ═══════════════════════════════════════════════════════════════════════

describe('G1: warmup state transitions', () => {
  it('PATCH /warmup pauses correctly when paused=true', async () => {
    queueRows([{ from_address: 'a@b.cz' }]) // mb lookup
    queueRows([]) // UPDATE mailbox_warmup
    const res = await req('PATCH', '/api/mailboxes/1/warmup', { paused: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // Second call updates warmup with the supplied paused value.
    expect(calls[1].sql).toMatch(/UPDATE mailbox_warmup\s+SET is_paused/i)
    expect(calls[1].params?.[0]).toBe(true)
  })

  it('PATCH /warmup resumes when paused=false', async () => {
    queueRows([{ from_address: 'a@b.cz' }])
    queueRows([])
    await req('PATCH', '/api/mailboxes/1/warmup', { paused: false })
    expect(calls[1].params?.[0]).toBe(false)
  })

  it('PATCH /warmup 404 when mailbox missing', async () => {
    queueRows([])
    const res = await req('PATCH', '/api/mailboxes/9999/warmup', { paused: true })
    expect(res.status).toBe(404)
  })

  it('POST /warmup/start UPSERT seeds warmup_day=1 + is_paused=false', async () => {
    queueRows([{ from_address: 'a@b.cz' }])
    queueRows([])
    const res = await req('POST', '/api/mailboxes/1/warmup/start')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, mailbox_address: 'a@b.cz' })
    expect(calls[1].sql).toMatch(/INSERT INTO mailbox_warmup/i)
    expect(calls[1].sql).toMatch(/ON CONFLICT\(mailbox_address\) DO UPDATE/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Pipeline results normalization
// ═══════════════════════════════════════════════════════════════════════

describe('G1: GET /api/mailboxes/:id/pipeline-results', () => {
  it('normalizes nested step entries to always have steps:[]', async () => {
    queueRows([
      {
        id: 1,
        overall_ok: true,
        steps: { smtp: { ok: true } /* no steps array */, imap: null, warmup: { ok: true } },
        tested_at: '2026-04-01',
      },
    ])
    const res = await req('GET', '/api/mailboxes/1/pipeline-results')
    expect(res.status).toBe(200)
    const arr = res.body as Array<{ steps: { smtp: { steps: unknown[] }; imap: unknown } }>
    expect(arr[0].steps.smtp.steps).toEqual([])
    // null sections stay null after normalize.
    expect(arr[0].steps.imap).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Alerts — list + resolve PATCH
// ═══════════════════════════════════════════════════════════════════════

describe('G1: alerts surface', () => {
  it('GET /alerts returns rows from mailbox_alerts ordered DESC LIMIT 50', async () => {
    queueRows([
      { id: 1, type: 'auth_fail', severity: 'high', message: 'm', created_at: '2026-04-01', resolved_at: null },
    ])
    const res = await req('GET', '/api/mailboxes/1/alerts')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(calls[0].sql).toMatch(/FROM mailbox_alerts/i)
    expect(calls[0].sql).toMatch(/ORDER BY created_at DESC/i)
    expect(calls[0].sql).toMatch(/LIMIT 50/)
  })

  it('PATCH /alerts/:alertId/resolve sets resolved_at and returns {ok:true}', async () => {
    queueRows([])
    const res = await req('PATCH', '/api/mailboxes/1/alerts/55/resolve')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(calls[0].sql).toMatch(/UPDATE mailbox_alerts SET resolved_at\s*=\s*now\(\)/i)
    expect(calls[0].params).toEqual(['55', '1'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Failure paths preserved
// ═══════════════════════════════════════════════════════════════════════

describe('G1: 500 propagation after extract', () => {
  it('GET /stats 500 on pg throw routes through capture500 (not silenced)', async () => {
    queueError('db down')
    const res = await req('GET', '/api/mailboxes/1/stats')
    expect(res.status).toBe(500)
  })

  it('POST /recover 500 on UPDATE throw (after id validation passes)', async () => {
    queueError('lock timeout')
    const res = await req('POST', '/api/mailboxes/1/recover')
    expect(res.status).toBe(500)
  })
})
