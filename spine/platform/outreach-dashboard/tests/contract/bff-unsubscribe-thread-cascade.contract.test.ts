// ═══════════════════════════════════════════════════════════════════════════
//  F2-1 — /unsubscribe must close outreach_threads (parity with Go-side
//         enrichment.SuppressEmail).
//
//  Pre-fix: BFF wrote suppression_list + outreach_suppressions + contacts.
//  status but never closed outreach_threads. Result: link-unsub recipient
//  saw the thank-you page but the thread stayed 'active' until the next
//  intelligence-loop sync — sends continued for hours/days.
//
//  Post-fix: BFF mirrors the Go-side cascade (features/acquisition/contacts/enrichment/
//  suppress.go SuppressEmail) — UPDATE outreach_contacts SET status='suppressed'
//  + UPDATE outreach_threads SET status='closed' WHERE contact_id = lookup
//  via email_hash. Both writes are best-effort (catch + warn) to match
//  prior MVP-1 belt-and-suspenders semantics.
//
//  Goes RED if anyone removes either the contacts mirror or the thread
//  cascade.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
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

const TEST_SECRET = 'test-unsub-secret-aaaaaaaaaaaaaaaa'

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'UNSUBSCRIBE_SECRET']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.UNSUBSCRIBE_SECRET = TEST_SECRET
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
function token(c: number, id: number, email: string, secret = TEST_SECRET) {
  return createHmac('sha256', secret).update(`${c}|${id}|${email}`).digest('hex').slice(0, 16)
}

describe('GET /unsubscribe — F2-1 thread cascade', () => {
  it('1: happy path issues UPDATE outreach_threads SET status=\'closed\' for the contact', async () => {
    pushAll(
      { rows: [{ email: 'jan@firma.cz' }] }, // contact lookup
      { rows: [] },                          // INSERT suppression_list
      { rows: [] },                          // INSERT outreach_suppressions
      { rows: [] },                          // UPDATE contacts SET status
      { rows: [] },                          // UPDATE outreach_contacts mirror (NEW)
      { rows: [] },                          // UPDATE outreach_threads cascade (NEW)
      { rows: [] },                          // INSERT operator_audit_log
    )
    const t = token(42, 1001, 'jan@firma.cz')
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${t}`)
    expect(res.status).toBe(200)

    const cascadeCalls = calls.filter(c =>
      /UPDATE\s+outreach_threads/i.test(c.sql) &&
      /status\s*=\s*'closed'/i.test(c.sql) &&
      /status\s+IN\s*\(\s*'new',\s*'active',\s*'paused'\s*\)/i.test(c.sql),
    )
    expect(cascadeCalls.length, 'must issue exactly one outreach_threads cascade UPDATE').toBe(1)
  })

  it('2: cascade query references contact_id via email_hash lookup (Schema B parity with Go SuppressEmail)', async () => {
    pushAll(
      { rows: [{ email: 'jan@firma.cz' }] },
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    )
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${token(42, 1001, 'jan@firma.cz')}`)
    const cascade = calls.find(c => /UPDATE\s+outreach_threads/i.test(c.sql))
    expect(cascade).toBeDefined()
    // The Go-side enrichment.SuppressEmail looks up contact_id via:
    //   contact_id = (SELECT id FROM outreach_contacts WHERE email_hash = encode(sha256(...)))
    // Verify the BFF mirrors that shape.
    expect(cascade!.sql).toMatch(/contact_id\s*=\s*\(/i)
    expect(cascade!.sql).toMatch(/FROM\s+outreach_contacts/i)
    expect(cascade!.sql).toMatch(/email_hash\s*=\s*encode\(sha256/i)
  })

  it('3: outreach_contacts.status=\'suppressed\' mirror UPDATE is issued (Schema B parity)', async () => {
    pushAll(
      { rows: [{ email: 'jan@firma.cz' }] },
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    )
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${token(42, 1001, 'jan@firma.cz')}`)
    const mirror = calls.find(c =>
      /UPDATE\s+outreach_contacts/i.test(c.sql) &&
      /status\s*=\s*'suppressed'/i.test(c.sql),
    )
    expect(mirror, 'BFF must mirror outreach_contacts.status=suppressed (parity with enrichment.SuppressEmail)').toBeDefined()
  })

  it('4: cascade only closes new/active/paused threads (does NOT touch already-closed/replied/bounced)', async () => {
    pushAll(
      { rows: [{ email: 'jan@firma.cz' }] },
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    )
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${token(42, 1001, 'jan@firma.cz')}`)
    const cascade = calls.find(c => /UPDATE\s+outreach_threads/i.test(c.sql))!
    expect(cascade.sql).toMatch(/status\s+IN\s*\(\s*'new',\s*'active',\s*'paused'\s*\)/i)
    // CRITICAL: must NOT close 'replied' or 'bounced' threads — those carry
    // forensic value (operator review, bounce-rate computation) and should
    // not be flipped to 'closed' just because the recipient unsubscribed.
    expect(cascade.sql).not.toMatch(/status\s+IN\s*\([^)]*'replied'/i)
    expect(cascade.sql).not.toMatch(/status\s+IN\s*\([^)]*'bounced'/i)
  })

  it('5: cascade failure does NOT 500 the response (best-effort, slog-warn only)', async () => {
    pushAll(
      { rows: [{ email: 'jan@firma.cz' }] },
      { rows: [] },                               // suppression_list ok
      { rows: [] },                               // outreach_suppressions ok
      { rows: [] },                               // contacts UPDATE ok
      { rows: [] },                               // outreach_contacts mirror ok
      new Error('thread cascade DB down'),         // cascade fails
      { rows: [] },                               // audit log ok
    )
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${token(42, 1001, 'jan@firma.cz')}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/Odhlášení proběhlo úspěšně/)
  })

  it('6: outreach_contacts mirror failure does NOT 500 the response (best-effort)', async () => {
    pushAll(
      { rows: [{ email: 'jan@firma.cz' }] },
      { rows: [] }, { rows: [] }, { rows: [] },
      new Error('Schema B not seeded'),            // outreach_contacts mirror fails
      { rows: [] }, { rows: [] },
    )
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${token(42, 1001, 'jan@firma.cz')}`)
    expect(res.status).toBe(200)
  })

  it('7: write order — primary writes happen BEFORE Schema B mirror+cascade', async () => {
    // The contract is: suppression_list and outreach_suppressions are the
    // canonical reads (UNION at every send-tick read site). Schema B mirror
    // + thread cascade are best-effort defense-in-depth and MUST NOT block
    // the primary writes.
    pushAll(
      { rows: [{ email: 'jan@firma.cz' }] },
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    )
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${token(42, 1001, 'jan@firma.cz')}`)
    const idxSuppList = calls.findIndex(c => /INSERT INTO suppression_list/i.test(c.sql))
    const idxOutSupp  = calls.findIndex(c => /INSERT INTO outreach_suppressions/i.test(c.sql))
    const idxContacts = calls.findIndex(c => /UPDATE\s+contacts\b/i.test(c.sql) && !/outreach_contacts/i.test(c.sql))
    const idxOutContacts = calls.findIndex(c => /UPDATE\s+outreach_contacts/i.test(c.sql))
    const idxCascade  = calls.findIndex(c => /UPDATE\s+outreach_threads/i.test(c.sql))

    expect(idxSuppList).toBeGreaterThan(-1)
    expect(idxOutSupp).toBeGreaterThan(idxSuppList)
    expect(idxContacts).toBeGreaterThan(idxOutSupp)
    expect(idxOutContacts).toBeGreaterThan(idxContacts)
    expect(idxCascade).toBeGreaterThan(idxOutContacts)
  })

  it('8: cascade params normalise email (lower + trim), matching enrichment.SuppressEmail', async () => {
    pushAll(
      { rows: [{ email: '  Jan@Firma.CZ  ' }] },
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    )
    await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${token(42, 1001, '  Jan@Firma.CZ  ')}`)
    const cascade = calls.find(c => /UPDATE\s+outreach_threads/i.test(c.sql))!
    // SQL must lower(trim(...)) the input so the email_hash matches what
    // the Go side computed at insert time.
    expect(cascade.sql).toMatch(/lower\(trim\(\$1::text\)\)/i)
  })

  it('9: bad token (403) MUST NOT issue any cascade write (no thread should close on a forged unsubscribe)', async () => {
    pushAll({ rows: [{ email: 'jan@firma.cz' }] }) // contact lookup, then 403 fires
    const wrongToken = token(42, 1001, 'jan@firma.cz', 'wrong-secret')
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=1001&t=${wrongToken}`)
    expect(res.status).toBe(403)
    const cascade = calls.filter(c => /UPDATE\s+outreach_threads/i.test(c.sql))
    expect(cascade.length, 'forged token must not close threads').toBe(0)
  })

  it('10: 404 contact MUST NOT issue any cascade write', async () => {
    pushAll({ rows: [] }) // contact not found → 404
    const t = token(42, 9999, 'ghost@test.cz')
    const res = await fetch(`${baseUrl}/unsubscribe?c=42&id=9999&t=${t}`)
    expect(res.status).toBe(404)
    const cascade = calls.filter(c => /UPDATE\s+outreach_threads/i.test(c.sql))
    expect(cascade.length).toBe(0)
  })
})
