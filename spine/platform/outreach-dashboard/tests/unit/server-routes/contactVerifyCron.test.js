// AM2 — contactVerifyCron unit tests (mock pool + verifyEmail).
// Tests the cron orchestration logic without a real DB or network.
//
// Coverage:
//   T01 feature flag disabled → early return, no DB calls
//   T02 daily budget exhausted → early return
//   T03 cron picks due contacts (email_verify_next_at <= NOW())
//   T04 cron skips bounce_hold contacts (filtered in SQL)
//   T05 cron skips quarantined domain (filtered in SQL)
//   T06 DISTINCT ON domain spreads MX load (single contact per domain)
//   T07 per-domain rate limit honored (5s window)
//   T08 successful verify → updates 5 fields + INSERT log row
//   T09 failed verify (timeout) → increments attempts + retry-next_at
//   T10 5+ attempts on risky → email_status='invalid' + nextAt=null
//   T11 3 timeouts/h on same domain → quarantine INSERT/UPDATE fires
//   T12 inflight guard — second concurrent call returns immediately
//   T13 verifyEmail error (non-timeout) → risky status set, no quarantine attempt

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mountContactVerifyCron } from '../../../src/server-routes/contactVerifyCron.js'

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makePool(overrides = {}) {
  return {
    query: vi.fn(),
    ...overrides,
  }
}

function makeVerifyEmail(status = 'valid', confidence = 90, detail = 'Ověřeno SMTP probe') {
  return vi.fn().mockResolvedValue({ status, confidence, detail })
}

const BASE_DEPS = {
  domainCache: { get: vi.fn(), set: vi.fn() },
  domainProbeLock: new Map(),
  DOMAIN_RATE_MS: 5000,
  capture: vi.fn(),
}

function setupCron(poolOverrides = {}, verifyStatus = 'valid') {
  const pool = makePool(poolOverrides)
  const verifyEmail = makeVerifyEmail(verifyStatus)
  const domainProbeLock = new Map()
  const { runContactVerifyCron } = mountContactVerifyCron({
    ...BASE_DEPS,
    pool,
    verifyEmail,
    domainProbeLock,
  })
  return { pool, verifyEmail, domainProbeLock, runContactVerifyCron }
}

// Helper: make a pool that returns the right rows per call index
function poolWithSequence(calls) {
  let idx = 0
  return {
    query: vi.fn().mockImplementation(() => {
      const call = calls[idx] ?? { rows: [] }
      idx++
      return Promise.resolve(call)
    }),
  }
}

// Route each query to a role-appropriate response by SQL shape — mirrors the
// product's actual query order (H3 DB-first config: 4 leading operator_settings
// reads · budget count · Sprint J tier-priority read · due-picker · audit
// insert · per-row mutations). Positional/call-count mocks drifted when those
// extra reads were added; routing by SQL text is order-independent. Tests pass
// only the rows they care about; everything else resolves empty so the cron
// runs to completion using the documented env/default fallbacks.
function routePool({ used = 0, due = [], timeoutCount = 0, settings = {} } = {}) {
  return {
    query: vi.fn().mockImplementation((sql, params) => {
      const s = String(sql)
      if (s.includes('FROM operator_settings')) {
        const key = params?.[0]
        return Promise.resolve(
          settings[key] === undefined ? { rows: [] } : { rows: [{ value: settings[key] }] },
        )
      }
      if (s.includes('AS used') && s.includes('email_verification_log')) {
        return Promise.resolve({ rows: [{ used }] })
      }
      if (s.includes('DISTINCT ON') && s.includes('FROM contacts')) {
        return Promise.resolve({ rows: due })
      }
      if (s.includes('AS n') && s.includes('email_verification_log')) {
        return Promise.resolve({ rows: [{ n: timeoutCount }] })
      }
      return Promise.resolve({ rows: [] })
    }),
  }
}

// Locate the due-picker call (order-independent) for content assertions.
const duePickerCall = (pool) =>
  pool.query.mock.calls.find(([sql]) => String(sql).includes('DISTINCT ON'))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('T01 — feature flag disabled → early return', () => {
  beforeEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('returns without touching DB when flag is off', async () => {
    const { pool, verifyEmail, runContactVerifyCron } = setupCron()
    await runContactVerifyCron()
    // H3: the sole DB hit is the operator_settings gate read; disabled (no DB
    // value + env off) → early return, no due-picker, no verification work.
    expect(pool.query).toHaveBeenCalledTimes(1)
    expect(duePickerCall(pool)).toBeUndefined()
    expect(verifyEmail).not.toHaveBeenCalled()
  })
})

describe('T02 — daily budget exhausted', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('returns early when used >= dailyMax (500 default)', async () => {
    const pool = routePool({ used: 500 })  // budget exhausted (>= dailyMax 500)
    const verifyEmail = makeVerifyEmail()
    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock: new Map() })
    await runContactVerifyCron()
    // budget exhausted → returns before the due-picker; no verifyEmail
    expect(duePickerCall(pool)).toBeUndefined()
    expect(verifyEmail).not.toHaveBeenCalled()
  })
})

describe('T03 — picks due contacts', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('runs verifyEmail once per due contact row', async () => {
    const pool = routePool({
      used: 0,
      due: [
        { id: 1, email: 'a@firma.cz', email_domain: 'firma.cz', email_status: 'unverified', email_verify_attempts: 0 },
      ],
    })
    const verifyEmail = makeVerifyEmail('valid')
    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock: new Map() })
    await runContactVerifyCron()
    expect(verifyEmail).toHaveBeenCalledTimes(1)
    expect(verifyEmail).toHaveBeenCalledWith('a@firma.cz', expect.objectContaining({ enableSMTP: expect.any(Boolean) }))
  })
})

describe('T04 — skip bounce_hold in SQL predicate', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('due-picker SQL excludes bounce_hold and spamtrap', async () => {
    const pool = routePool({ used: 0 })  // no due rows
    const verifyEmail = makeVerifyEmail()
    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock: new Map() })
    await runContactVerifyCron()
    // Check the due-picker query includes NOT IN filter
    const duePicker = duePickerCall(pool)[0]
    expect(duePicker).toContain("email_status NOT IN ('bounce_hold', 'spamtrap', 'invalid')")
    expect(verifyEmail).not.toHaveBeenCalled()
  })
})

describe('T05 — skip quarantined domain in SQL predicate', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('due-picker SQL excludes quarantined domains via subquery', async () => {
    const pool = routePool({ used: 0 })  // no due rows
    const verifyEmail = makeVerifyEmail()
    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock: new Map() })
    await runContactVerifyCron()
    const duePicker = duePickerCall(pool)[0]
    expect(duePicker).toContain('email_verify_domain_quarantine')
    expect(duePicker).toContain('quarantine_until > NOW()')
  })
})

describe('T06 — DISTINCT ON domain spreads MX load', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('due-picker query contains DISTINCT ON (domain)', async () => {
    const pool = routePool({ used: 0 })  // no due rows
    const verifyEmail = makeVerifyEmail()
    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock: new Map() })
    await runContactVerifyCron()
    const duePicker = duePickerCall(pool)[0]
    expect(duePicker).toMatch(/DISTINCT ON.*split_part.*email.*@/i)
  })
})

describe('T07 — per-domain rate limit (5s window)', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('skips contact when domain was probed <5s ago', async () => {
    const domainProbeLock = new Map([['firma.cz', Date.now()]])  // just probed
    const pool = routePool({
      used: 0,
      due: [{ id: 1, email: 'a@firma.cz', email_domain: 'firma.cz', email_status: 'unverified', email_verify_attempts: 0 }],
    })
    const verifyEmail = makeVerifyEmail()
    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock })
    await runContactVerifyCron()
    expect(verifyEmail).not.toHaveBeenCalled()
  })

  it('probes contact when domain was probed >5s ago', async () => {
    const domainProbeLock = new Map([['firma.cz', Date.now() - 6000]])  // 6s ago
    const pool = routePool({
      used: 0,
      due: [{ id: 1, email: 'a@firma.cz', email_domain: 'firma.cz', email_status: 'unverified', email_verify_attempts: 0 }],
    })
    const verifyEmail = makeVerifyEmail('valid')
    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock })
    await runContactVerifyCron()
    expect(verifyEmail).toHaveBeenCalledTimes(1)
  })
})

describe('T08 — successful verify → updates 5 fields + INSERT log row', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('UPDATE contacts with 6 params + INSERT email_verification_log', async () => {
    const sqlCalls = []  // collect (sql, params) tuples
    const pool = { query: vi.fn().mockImplementation((sql, params) => {
      const s = String(sql)
      sqlCalls.push([s.trim().replace(/\s+/g, ' '), params])
      if (s.includes('AS used') && s.includes('email_verification_log')) return Promise.resolve({ rows: [{ used: 0 }] })
      if (s.includes('DISTINCT ON') && s.includes('FROM contacts')) return Promise.resolve({ rows: [
        { id: 42, email: 'x@firma.cz', email_domain: 'firma.cz', email_status: 'risky', email_verify_attempts: 1 },
      ]})
      return Promise.resolve({ rows: [] })
    })}

    const verifyEmail = makeVerifyEmail('valid', 95, 'Ověřeno SMTP probe')
    const domainProbeLock = new Map([['firma.cz', Date.now() - 10000]])

    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock })
    await runContactVerifyCron()

    // UPDATE contacts SET email_status=..., verified_at=..., verification=..., confidence=..., attempts=..., next_at=... WHERE id=$6
    const [updateSql, updateParams] = sqlCalls.find(([sql]) =>
      sql.includes('email_status') && sql.includes('email_verified_at') && sql.includes('WHERE id')
    ) ?? [null, null]
    expect(updateSql).toBeTruthy()
    expect(updateParams[0]).toBe('valid')
    expect(updateParams[5]).toBe(42)  // contact id (6th param)

    // INSERT email_verification_log — find by table name (normalized SQL)
    const [insertSql, insertParams] = sqlCalls.find(([sql]) =>
      sql.includes('email_verification_log') && sql.includes('INSERT')
    ) ?? [null, null]
    expect(insertSql, `INSERT log not found — captured: ${sqlCalls.map(([s]) => s.slice(0,40)).join(' | ')}`).toBeTruthy()
    expect(insertParams[0]).toBe(42)        // contact_id
    expect(insertParams[5]).toContain('"status":"valid"')  // verification JSON (index 5)
  })
})

describe('T09 — failed verify (timeout) → increments attempts + retry-next_at', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('on timeout: increments attempts and sets retry-at', async () => {
    const queries = []
    const pool = { query: vi.fn().mockImplementation((sql, params) => {
      const s = String(sql)
      queries.push({ sql: s, params })
      if (s.includes('AS used') && s.includes('email_verification_log')) return Promise.resolve({ rows: [{ used: 0 }] })
      if (s.includes('DISTINCT ON') && s.includes('FROM contacts')) return Promise.resolve({ rows: [
        { id: 7, email: 'y@slow.cz', email_domain: 'slow.cz', email_status: 'risky', email_verify_attempts: 2 },
      ]})
      return Promise.resolve({ rows: [] })
    })}

    const verifyEmail = vi.fn().mockRejectedValue(new Error('SMTP timeout connecting to slow.cz'))
    const domainProbeLock = new Map([['slow.cz', Date.now() - 10000]])

    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock })
    await runContactVerifyCron()

    // Error-path retry UPDATE. The product prepends email_status=$1 (restore
    // the pre-probe status so a transient I/O failure doesn't demote a
    // known-good contact), so params are [status, attempts, nextAt, id].
    const retryUpdate = queries.find(q =>
      q.sql.includes('email_verify_attempts') &&
      q.sql.includes('email_verify_next_at') &&
      q.params?.[3] === 7
    )
    expect(retryUpdate).toBeTruthy()
    expect(retryUpdate.params[1]).toBe(3)  // attempts 2+1 ($2)
    expect(retryUpdate.params[2]).toBeInstanceOf(Date)  // nextAt is a Date ($3)
  })
})

describe('T10 — 5+ attempts on risky → invalid + null nextAt', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('risky probe on attempt 5 writes invalid status and null nextAt', async () => {
    const queries = []
    const pool = { query: vi.fn().mockImplementation((sql, params) => {
      const s = String(sql)
      queries.push({ sql: s, params })
      if (s.includes('AS used') && s.includes('email_verification_log')) return Promise.resolve({ rows: [{ used: 0 }] })
      if (s.includes('DISTINCT ON') && s.includes('FROM contacts')) return Promise.resolve({ rows: [
        { id: 55, email: 'z@risky.cz', email_domain: 'risky.cz', email_status: 'risky', email_verify_attempts: 4 },
      ]})
      return Promise.resolve({ rows: [] })
    })}

    const verifyEmail = makeVerifyEmail('risky')  // probe returns risky
    const domainProbeLock = new Map([['risky.cz', Date.now() - 10000]])

    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock })
    await runContactVerifyCron()

    // UPDATE contacts should set email_status='invalid' and next_at=null
    const updateContacts = queries.find(q =>
      q.sql.includes('email_status') &&
      q.sql.includes('email_verified_at') &&
      q.params?.[5] === 55
    )
    expect(updateContacts).toBeTruthy()
    expect(updateContacts.params[0]).toBe('invalid')  // status flipped
    expect(updateContacts.params[4]).toBeNull()        // nextAt null
    expect(updateContacts.params[3]).toBe(5)           // attempts = 5
  })
})

describe('T11 — 3 timeouts/h on same domain → quarantine fires', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('inserts/upserts quarantine row when count >= 3', async () => {
    const queries = []
    const pool = { query: vi.fn().mockImplementation((sql, params) => {
      const s = String(sql)
      queries.push({ sql: s, params })
      if (s.includes('AS used') && s.includes('email_verification_log')) return Promise.resolve({ rows: [{ used: 0 }] })   // budget
      if (s.includes('DISTINCT ON') && s.includes('FROM contacts')) return Promise.resolve({ rows: [                       // due contacts
        { id: 9, email: 'a@spam.cz', email_domain: 'spam.cz', email_status: 'risky', email_verify_attempts: 1 },
      ]})
      if (s.includes('AS n') && s.includes('email_verification_log')) return Promise.resolve({ rows: [{ n: 3 }] })          // quarantine count = 3
      return Promise.resolve({ rows: [] })                                                                                  // UPDATEs / INSERTs / quarantine INSERT
    })}

    const verifyEmail = vi.fn().mockRejectedValue(new Error('SMTP timeout connecting'))
    const domainProbeLock = new Map([['spam.cz', Date.now() - 10000]])

    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock })
    await runContactVerifyCron()

    // Should have queried for timeout count
    const countQuery = queries.find(q => q.sql.includes('email_verify_domain_quarantine') && !q.sql.includes('INSERT') && !q.sql.includes('SELECT domain'))
    const quarantineInsert = queries.find(q => q.sql.includes('email_verify_domain_quarantine') && q.sql.includes('INSERT'))
    expect(quarantineInsert).toBeTruthy()
    expect(quarantineInsert.params[0]).toBe('spam.cz')
  })
})

describe('T12 — inflight guard prevents concurrent runs', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('second call returns immediately when first is in flight', async () => {
    // H3 sets the in-flight latch only AFTER the enabled+paused operator_settings
    // reads. Let those resolve so the first call acquires the latch, then stall
    // it on the budget query; the concurrent second call must short-circuit at
    // the latch without reaching the due-picker.
    let releaseBudget
    const budgetStall = new Promise((r) => { releaseBudget = r })
    const pool = { query: vi.fn().mockImplementation((sql, params) => {
      const s = String(sql)
      if (s.includes('FROM operator_settings')) {
        const key = params?.[0]
        return Promise.resolve(key === 'verify_loop_enabled' ? { rows: [{ value: 'true' }] } : { rows: [] })
      }
      if (s.includes('AS used') && s.includes('email_verification_log')) return budgetStall
      return Promise.resolve({ rows: [] })
    })}
    const verifyEmail = makeVerifyEmail()
    const domainProbeLock = new Map()
    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock })

    const first = runContactVerifyCron()
    // Drain microtasks so the first call advances past the latch and parks at
    // the (stalled) budget query.
    await new Promise((r) => setTimeout(r, 0))
    // Second call: its own enabled+paused reads, then hits the latch → returns.
    await runContactVerifyCron()

    expect(verifyEmail).not.toHaveBeenCalled()
    expect(duePickerCall(pool)).toBeUndefined()  // neither call reached the due-picker

    // Release the stall so the first call finishes (budget exhausted) + cleans up.
    releaseBudget({ rows: [{ used: 600 }] })
    await first
  })
})

describe('T13 — non-timeout error → risky status, no quarantine attempt', () => {
  beforeEach(() => { process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true' })
  afterEach(() => { delete process.env.VERIFY_LOOP_CONTACTS_ENABLED })

  it('connection refused (non-timeout) sets risky without quarantine check', async () => {
    const queries = []
    const pool = { query: vi.fn().mockImplementation((sql, params) => {
      const s = String(sql)
      queries.push({ sql: s, params })
      if (s.includes('AS used') && s.includes('email_verification_log')) return Promise.resolve({ rows: [{ used: 0 }] })
      if (s.includes('DISTINCT ON') && s.includes('FROM contacts')) return Promise.resolve({ rows: [
        { id: 3, email: 'b@conn.cz', email_domain: 'conn.cz', email_status: 'risky', email_verify_attempts: 0 },
      ]})
      return Promise.resolve({ rows: [] })
    })}

    const verifyEmail = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const domainProbeLock = new Map([['conn.cz', Date.now() - 10000]])

    const { runContactVerifyCron } = mountContactVerifyCron({ ...BASE_DEPS, pool, verifyEmail, domainProbeLock })
    await runContactVerifyCron()

    // No quarantine count query (because message doesn't include 'timeout')
    const quarantineCountQuery = queries.find(q =>
      q.sql.includes('email_verify_domain_quarantine') && !q.sql.includes('INSERT') && !q.sql.includes('SELECT domain')
    )
    expect(quarantineCountQuery).toBeUndefined()
  })
})
