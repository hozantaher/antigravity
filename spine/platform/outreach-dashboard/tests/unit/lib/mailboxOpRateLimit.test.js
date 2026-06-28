import { describe, it, expect, beforeEach } from 'vitest'
import { checkAndRecord, OP_RATE_CAPS } from '../../../src/lib/mailboxOpRateLimit'

// Mock pg.Pool
class MockPool {
  constructor() {
    this.results = []
    this.rollbackCalled = false
  }

  async connect() {
    return new MockClient(this)
  }
}

class MockClient {
  constructor(pool) {
    this.pool = pool
    this.queries = []
    this.transactionActive = false
  }

  async query(sql, params) {
    this.queries.push({ sql, params })

    if (sql.includes('BEGIN')) {
      this.transactionActive = true
      return { rowCount: 1, rows: [] }
    }

    if (sql.includes('COMMIT')) {
      this.transactionActive = false
      return { rowCount: 1, rows: [] }
    }

    if (sql.includes('ROLLBACK')) {
      this.transactionActive = false
      return { rowCount: 1, rows: [] }
    }

    // SELECT ... FOR UPDATE — return empty to test P2 fix
    if (sql.includes('FOR UPDATE')) {
      return {
        rowCount: this.pool.results.noMailbox ? 0 : 1,
        rows: this.pool.results.noMailbox ? [] : [{ 1: 1 }]
      }
    }

    // COUNT query
    if (sql.includes('count(*)')) {
      const used = this.pool.results.countUsed ?? 0
      return {
        rowCount: 1,
        rows: [{
          used,
          oldest_in_window: used >= OP_RATE_CAPS.imap_poll.max ? new Date() : null
        }]
      }
    }

    // INSERT
    if (sql.includes('INSERT INTO mailbox_op_rate_log')) {
      return { rowCount: 1, rows: [] }
    }

    return { rowCount: 0, rows: [] }
  }

  release() {}
}

describe('mailboxOpRateLimit', () => {
  let pool

  beforeEach(() => {
    pool = new MockPool()
  })

  it('P2 FIX: mailbox_not_found when FOR UPDATE locks 0 rows', async () => {
    pool.results.noMailbox = true
    pool.results.countUsed = 0

    const result = await checkAndRecord(pool, 999, 'imap_poll')

    expect(result).toEqual({
      allowed: false,
      error: 'mailbox_not_found'
    })
  })

  it('allows operation when under cap', async () => {
    pool.results.noMailbox = false
    pool.results.countUsed = 0

    const result = await checkAndRecord(pool, 1, 'imap_poll')

    expect(result.allowed).toBe(true)
    expect(result.used).toBe(1)
    expect(result.max).toBe(OP_RATE_CAPS.imap_poll.max)
  })

  it('rejects operation when at cap', async () => {
    pool.results.noMailbox = false
    const cap = OP_RATE_CAPS.imap_poll
    pool.results.countUsed = cap.max

    const result = await checkAndRecord(pool, 1, 'imap_poll')

    expect(result.allowed).toBe(false)
    expect(result.used).toBe(cap.max)
    expect(result.max).toBe(cap.max)
  })

  it('respects per-op-type caps', async () => {
    pool.results.noMailbox = false
    pool.results.countUsed = 0

    const result = await checkAndRecord(pool, 1, 'smtp_probe')

    expect(result.max).toBe(OP_RATE_CAPS.smtp_probe.max)
  })

  it('throws on unknown op_type', async () => {
    pool.results.noMailbox = false
    pool.results.countUsed = 0

    await expect(() => checkAndRecord(pool, 1, 'invalid_op')).rejects.toThrow()
  })
})
