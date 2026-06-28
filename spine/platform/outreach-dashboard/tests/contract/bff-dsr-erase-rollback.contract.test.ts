// ═══════════════════════════════════════════════════════════════════════════
//  F2-2 — DSR erase: tracking_events failure must ROLLBACK + 500
//
//  Pre-fix: tracking_events DELETE inside the BEGIN/COMMIT block had
//  `.catch(() => ({ rowCount: 0 }))`. If the DELETE failed (missing
//  table, permissions, FK violation), the catch returned a fake
//  zero-row result and the transaction kept going — reply_inbox,
//  send_events, outreach_contacts, contacts all DELETED, audit log
//  INSERT, COMMIT — while tracking_events still held the PII.
//
//  GDPR Art.17 requires all-or-nothing erasure. Let the DB error
//  propagate to the outer catch which ROLLBACKs and 500s.
//
//  Goes RED if anyone reintroduces the silent .catch on a delete
//  inside the DSR transaction.
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
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  vi.resetModules()
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

function pushAll(...outcomes: QueryOutcome[]) { queryQueue.push(...outcomes) }

async function postErase(email = 'jan@firma.cz') {
  return fetch(`${baseUrl}/api/dsr/erase?email=${encodeURIComponent(email)}`, { method: 'POST' })
}

describe('POST /api/dsr/erase — F2-2 transaction integrity', () => {
  it('1: tracking_events DELETE failure → 500 + ROLLBACK + NO audit log', async () => {
    pushAll(
      { rows: [] },                           // BEGIN
      { rows: [{ id: 7 }] },                   // SELECT contact ids
      new Error('tracking_events permission denied'), // DELETE tracking_events FAILS
    )
    const res = await postErase()
    expect(res.status).toBe(500)

    // ROLLBACK must have been issued.
    const rollback = calls.find(c => /ROLLBACK/i.test(c.sql))
    expect(rollback, 'must ROLLBACK on any DELETE failure inside the tx').toBeDefined()

    // Audit log INSERT MUST NOT have happened (would falsely claim success).
    const audit = calls.find(c => /INSERT INTO operator_audit_log/i.test(c.sql))
    expect(audit, 'audit log MUST NOT be written when tx fails').toBeUndefined()

    // suppression_list "belt-and-suspenders" insert ALSO must not have run
    // — it's inside the tx and the abort happened before reaching it.
    const supp = calls.find(c =>
      /INSERT INTO suppression_list/i.test(c.sql) && c.params?.[1] === 'gdpr_erasure',
    )
    expect(supp).toBeUndefined()

    // COMMIT must NOT have been issued.
    const commit = calls.find(c => /COMMIT/i.test(c.sql))
    expect(commit).toBeUndefined()
  })

  it('2: reply_inbox DELETE failure → 500 + ROLLBACK + no audit', async () => {
    pushAll(
      { rows: [] },
      { rows: [{ id: 7 }] },
      { rowCount: 3 },                          // tracking_events ok
      new Error('reply_inbox conn reset'),      // reply_inbox FAILS
    )
    const res = await postErase()
    expect(res.status).toBe(500)
    expect(calls.find(c => /ROLLBACK/i.test(c.sql))).toBeDefined()
    expect(calls.find(c => /INSERT INTO operator_audit_log/i.test(c.sql))).toBeUndefined()
  })

  it('3: send_events DELETE failure → 500 + ROLLBACK', async () => {
    pushAll(
      { rows: [] },
      { rows: [{ id: 7 }] },
      { rowCount: 3 }, { rowCount: 1 },        // tracking, reply_inbox ok
      new Error('send_events FK violation'),   // send_events FAILS
    )
    const res = await postErase()
    expect(res.status).toBe(500)
    expect(calls.find(c => /ROLLBACK/i.test(c.sql))).toBeDefined()
  })

  it('4: outreach_contacts DELETE failure → 500 + ROLLBACK', async () => {
    pushAll(
      { rows: [] },
      { rows: [{ id: 7 }] },
      { rowCount: 3 }, { rowCount: 1 }, { rowCount: 5 }, // earlier deletes ok
      new Error('outreach_contacts down'),               // outreach_contacts FAILS
    )
    const res = await postErase()
    expect(res.status).toBe(500)
    expect(calls.find(c => /ROLLBACK/i.test(c.sql))).toBeDefined()
  })

  it('5: contacts DELETE failure → 500 + ROLLBACK', async () => {
    pushAll(
      { rows: [] },
      { rows: [{ id: 7 }] },
      { rowCount: 3 }, { rowCount: 1 }, { rowCount: 5 }, { rowCount: 1 },
      new Error('contacts gone'),               // contacts FAILS
    )
    const res = await postErase()
    expect(res.status).toBe(500)
    expect(calls.find(c => /ROLLBACK/i.test(c.sql))).toBeDefined()
  })

  it('6: happy path — all 5 DELETEs ok, audit log written, COMMIT issued', async () => {
    pushAll(
      { rows: [] },                             // BEGIN
      { rows: [{ id: 7 }] },                    // SELECT contact ids
      { rowCount: 3 },                          // tracking
      { rowCount: 1 },                          // reply_inbox
      { rowCount: 5 },                          // send_events
      { rowCount: 1 },                          // outreach_contacts
      { rowCount: 1 },                          // contacts
      { rowCount: 1 },                          // suppression_list (belt-and-suspenders)
      { rowCount: 1 },                          // operator_audit_log
      { rows: [] },                             // COMMIT
    )
    const res = await postErase()
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; deleted: Record<string, number> }
    expect(body.ok).toBe(true)
    expect(body.deleted).toMatchObject({
      tracking_events: 3, reply_inbox: 1, send_events: 5,
      outreach_contacts: 1, contacts: 1,
    })
    expect(calls.find(c => /COMMIT/i.test(c.sql))).toBeDefined()
    expect(calls.find(c => /INSERT INTO operator_audit_log/i.test(c.sql))).toBeDefined()
  })

  it('7: source-level audit — DSR erase tx must NOT contain `.catch(() => ({ rowCount: 0 }))`', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    // Post-T2.6: handler extracted to src/server-routes/dsr.js.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'server-routes', 'dsr.js'), 'utf8')

    // Find the tracking_events DELETE region and audit it specifically.
    // The F2-2 fix scope: tracking_events DELETE must NOT swallow errors.
    // (Other intentional `.catch(() => ({ rowCount: 0 }))` exist for
    // schema-optional cascades like channel_audit_log on dev DBs without
    // migration 019; those are documented & gated by their own invariants.)
    const region = src.match(/DELETE FROM tracking_events[\s\S]{0,400}/)
    expect(region, 'tracking_events DELETE must exist in handler').not.toBeNull()
    const trackingSrc = region![0]
    expect(trackingSrc, 'tracking_events DELETE must not silently swallow errors')
      .not.toMatch(/\)\s*\.catch\(\s*\(\s*\)\s*=>\s*\(\s*\{\s*rowCount\s*:\s*0\s*\}\s*\)\s*\)/)
  })
})
