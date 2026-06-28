// ═══════════════════════════════════════════════════════════════════════════
//  P0 incident 2026-05-14 — BFF contract for POST /api/mailboxes/:id/refresh-imap
//
// Operator-triggered force re-poll endpoint that mirrors runImapPollCron's
// per-mailbox logic for one mailbox. Used when an operator sees a reply in
// webmail but it has not yet been picked up by the 5-minute cron tick.
//
// This contract test focuses on the guard rails the BFF enforces BEFORE
// hitting the relay layer:
//   1. X-Confirm-Send header gate (state-changing mutation)
//   2. Invalid id rejected with 400
//   3. Missing mailbox / locked mailbox → 404
//   4. Mailbox without imap_host → 400 (cannot fetch)
//
// Deeper integration (relay success path, orchestrator forwarding) is
// covered by tests/integration/imap-socks5-end-to-end.test.ts; mocking the
// relay client here proved to break server boot in BFF_IMPORT_ONLY mode
// so we keep the contract surface narrow.
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.GO_SERVER_URL = 'http://orchestrator-stub:8080'
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

async function postRefresh(id: number | string, headers: Record<string, string> = {}) {
  const r = await fetch(baseUrl + `/api/mailboxes/${id}/refresh-imap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json as Record<string, unknown> | null }
}

describe('POST /api/mailboxes/:id/refresh-imap — P0 incident 2026-05-14 contract', () => {
  it('rejects request missing X-Confirm-Send header with 400', async () => {
    const res = await postRefresh(1180)
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('missing_confirmation')
  })

  it('rejects invalid mailbox id (non-numeric) with 400', async () => {
    const res = await postRefresh('abc', { 'X-Confirm-Send': 'yes' })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('invalid_id')
  })

  it('rejects zero mailbox id with 400', async () => {
    const res = await postRefresh(0, { 'X-Confirm-Send': 'yes' })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('invalid_id')
  })

  it('rejects negative mailbox id with 400', async () => {
    const res = await postRefresh(-5, { 'X-Confirm-Send': 'yes' })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('invalid_id')
  })

  it('returns 404 when mailbox missing or auth_locked', async () => {
    queueRows([]) // SELECT returns nothing
    const res = await postRefresh(9999, { 'X-Confirm-Send': 'yes' })
    expect(res.status).toBe(404)
    expect(res.body?.error).toBe('mailbox_not_found_or_locked')
  })

  it('returns 400 when mailbox has no imap_host', async () => {
    queueRows([{
      id: 1180,
      from_address: 'a@b.cz',
      imap_host: null,
      imap_port: 993,
      imap_username: 'u',
      smtp_username: 'u',
      password: 'p',
      preferred_country: 'CZ',
      prev_uid: 0,
      prev_uid_validity: null,
    }])
    const res = await postRefresh(1180, { 'X-Confirm-Send': 'yes' })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('no_imap_configured')
  })

  it('non-numeric float id ("1.5") rejected with 400', async () => {
    const res = await postRefresh('1.5', { 'X-Confirm-Send': 'yes' })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('invalid_id')
  })

  it('X-Confirm-Send with non-"yes" value still rejected with 400', async () => {
    const res = await postRefresh(1180, { 'X-Confirm-Send': 'maybe' })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('missing_confirmation')
  })
})
