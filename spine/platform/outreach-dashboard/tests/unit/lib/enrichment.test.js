import { describe, it, expect, vi } from 'vitest'
import {
  SourceRateLimiter,
  CircuitBreaker,
  backoffSeconds,
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  persistFacts,
  claimJobs,
  markJobDone,
  markJobFailed,
  enqueueJob,
  runWorkerTick,
} from '../../../src/lib/enrichment.js'

describe('backoffSeconds', () => {
  it('matches schedule', () => {
    expect(backoffSeconds(0)).toBe(BACKOFF_SECONDS[0])
    expect(backoffSeconds(2)).toBe(BACKOFF_SECONDS[2])
  })
  it('clamps above MAX_ATTEMPTS to last value', () => {
    expect(backoffSeconds(99)).toBe(BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1])
  })
  it('treats junk as attempt=0', () => {
    expect(backoffSeconds('abc')).toBe(BACKOFF_SECONDS[0])
    expect(backoffSeconds(-3)).toBe(BACKOFF_SECONDS[0])
  })
})

describe('SourceRateLimiter (token bucket)', () => {
  it('starts full at capacity', () => {
    const l = new SourceRateLimiter(60)
    expect(l.available()).toBe(60)
  })
  it('tryTake decrements one token', () => {
    const l = new SourceRateLimiter(60)
    expect(l.tryTake()).toBe(true)
    expect(l.available()).toBeCloseTo(59, 1)
  })
  it('refuses tryTake when empty', () => {
    let now = 1_000_000
    const l = new SourceRateLimiter(60, () => now)
    for (let i = 0; i < 60; i++) l.tryTake()
    expect(l.tryTake()).toBe(false)
  })
  it('refills linearly with simulated clock', () => {
    let now = 1_000_000
    const l = new SourceRateLimiter(60, () => now)
    for (let i = 0; i < 60; i++) l.tryTake()
    now += 1_000  // 1s = 1 token at 60/min
    expect(l.tryTake()).toBe(true)
    expect(l.tryTake()).toBe(false)
  })
  it('msUntilNextToken is 0 when token available', () => {
    const l = new SourceRateLimiter(60)
    expect(l.msUntilNextToken()).toBe(0)
  })
  it('msUntilNextToken is positive when empty', () => {
    let now = 1_000_000
    const l = new SourceRateLimiter(60, () => now)
    for (let i = 0; i < 60; i++) l.tryTake()
    expect(l.msUntilNextToken()).toBeGreaterThan(0)
  })
  it('take() awaits using injected sleep', async () => {
    let now = 1_000_000
    const l = new SourceRateLimiter(60, () => now)
    for (let i = 0; i < 60; i++) l.tryTake()
    const sleep = vi.fn(async ms => { now += ms })
    await l.take(sleep)
    expect(sleep).toHaveBeenCalledOnce()
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0)
  })
  it('take() does not sleep when token available', async () => {
    const l = new SourceRateLimiter(60)
    const sleep = vi.fn()
    await l.take(sleep)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    expect(new CircuitBreaker().isOpen()).toBe(false)
  })
  it('opens after threshold consecutive failures', () => {
    const b = new CircuitBreaker(3)
    b.recordFailure(); b.recordFailure()
    expect(b.isOpen()).toBe(false)
    b.recordFailure()
    expect(b.isOpen()).toBe(true)
  })
  it('success resets the failure counter', () => {
    const b = new CircuitBreaker(3)
    b.recordFailure(); b.recordFailure()
    b.recordSuccess()
    b.recordFailure(); b.recordFailure()
    expect(b.isOpen()).toBe(false)
  })
  it('closes again after cooldown elapses', () => {
    let now = 1_000_000
    const b = new CircuitBreaker(2, 5_000, () => now)
    b.recordFailure(); b.recordFailure()
    expect(b.isOpen()).toBe(true)
    now += 6_000
    expect(b.isOpen()).toBe(false)
  })
})

// ── Pool fixture: tracks queries, responds with rowsets per pattern ──
function fakePool(handlers = {}) {
  const calls = []
  return {
    calls,
    query: vi.fn(async (sql, params = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      for (const [pattern, response] of Object.entries(handlers)) {
        if (sql.includes(pattern)) {
          const r = typeof response === 'function' ? await response(sql, params) : response
          return r
        }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
}

describe('persistFacts', () => {
  it('inserts each fact with JSONB value + supplied confidence', async () => {
    const pool = fakePool({ 'INSERT INTO company_facts': { rows: [], rowCount: 1 } })
    const n = await persistFacts(pool, 42, 'manual',
      [
        { field: 'revenue', value: 1_000_000, base_confidence: 0.99, ttl_days: 365 },
        { field: 'team_size', value: 25 },
      ],
      'manual_v1',
      { base_confidence: 0.7, ttl_days: 90 },
    )
    expect(n).toBe(2)
    expect(pool.calls).toHaveLength(2)
    expect(pool.calls[0].params[0]).toBe(42)
    expect(pool.calls[0].params[1]).toBe('manual')
    expect(pool.calls[0].params[2]).toBe('revenue')
    expect(pool.calls[0].params[3]).toBe('1000000')   // JSONB-encoded
    expect(pool.calls[0].params[4]).toBe(0.99)
    expect(pool.calls[0].params[5]).toBe(365)
    expect(pool.calls[1].params[4]).toBe(0.7)         // fallback to source default
    expect(pool.calls[1].params[5]).toBe(90)
  })
  it('returns 0 for empty input', async () => {
    const pool = fakePool()
    expect(await persistFacts(pool, 1, 'manual', [])).toBe(0)
    expect(await persistFacts(pool, 1, 'manual', null)).toBe(0)
  })
  it('skips facts with missing field or undefined value', async () => {
    const pool = fakePool({ 'INSERT INTO company_facts': { rows: [], rowCount: 1 } })
    await persistFacts(pool, 1, 'manual', [
      { field: 'a', value: 1 },
      { field: '', value: 1 },
      { value: 1 },
      { field: 'b', value: undefined },
      { field: 'c', value: null },        // null is a valid JSON value, kept
    ], 'v1')
    expect(pool.calls).toHaveLength(2)
  })
  it('idempotent on duplicate (rowCount=0)', async () => {
    const pool = fakePool({ 'INSERT INTO company_facts': { rows: [], rowCount: 0 } })
    const n = await persistFacts(pool, 1, 'manual', [{ field: 'x', value: 1 }], 'v1')
    expect(n).toBe(0)
  })
  it('wraps DB errors with source.field context', async () => {
    const pool = fakePool({
      'INSERT INTO company_facts': () => { throw new Error('boom') },
    })
    await expect(
      persistFacts(pool, 1, 'manual', [{ field: 'x', value: 1 }], 'v1')
    ).rejects.toThrow(/manual\.x.*boom/)
  })
})

describe('claimJobs', () => {
  it('issues SKIP LOCKED claim and returns rows', async () => {
    const pool = fakePool({
      'UPDATE enrichment_jobs SET status=': { rows: [{ id: 1, company_id: 100, source: 'manual', attempt: 1 }], rowCount: 1 },
    })
    const rows = await claimJobs(pool, 'manual', 5)
    expect(rows).toHaveLength(1)
    expect(pool.calls[0].sql).toMatch(/SKIP LOCKED/)
    expect(pool.calls[0].params).toEqual(['manual', 5])
  })
  it('clamps batchSize to [1, 100]', async () => {
    const pool = fakePool()
    await claimJobs(pool, 's', 0)
    await claimJobs(pool, 's', 9999)
    expect(pool.calls[0].params[1]).toBe(1)
    expect(pool.calls[1].params[1]).toBe(100)
  })
})

describe('markJobDone / markJobFailed', () => {
  it('markJobDone updates row to done', async () => {
    const pool = fakePool()
    await markJobDone(pool, 7)
    expect(pool.calls[0].sql).toMatch(/SET status='done'/)
    expect(pool.calls[0].params).toEqual([7])
  })
  it('markJobFailed schedules backoff while under MAX_ATTEMPTS', async () => {
    const pool = fakePool()
    await markJobFailed(pool, 7, 1, 'http 503')
    const c = pool.calls[0]
    expect(c.params[0]).toBe('pending')
    expect(c.params[1]).toBe(BACKOFF_SECONDS[1])
    expect(c.params[2]).toBe('http 503')
    expect(c.params[3]).toBe(7)
  })
  it('markJobFailed marks dead when attempt >= MAX_ATTEMPTS', async () => {
    const pool = fakePool()
    await markJobFailed(pool, 7, MAX_ATTEMPTS, 'permanent')
    expect(pool.calls[0].params[0]).toBe('dead')
    expect(pool.calls[0].params[1]).toBe(null)
  })
})

describe('enqueueJob', () => {
  it('returns true when row inserted', async () => {
    const pool = fakePool({ 'INSERT INTO enrichment_jobs': { rows: [{ id: 1 }], rowCount: 1 } })
    expect(await enqueueJob(pool, 1, 'manual')).toBe(true)
  })
  it('returns false when duplicate (rowCount=0)', async () => {
    const pool = fakePool({ 'INSERT INTO enrichment_jobs': { rows: [], rowCount: 0 } })
    expect(await enqueueJob(pool, 1, 'manual')).toBe(false)
  })
})

describe('runWorkerTick', () => {
  const sources = [
    { source: 'a', enabled: true,  base_confidence: 0.9, default_ttl_days: 30 },
    { source: 'b', enabled: false, base_confidence: 0.9, default_ttl_days: 30 },
    { source: 'c', enabled: true,  base_confidence: 0.9, default_ttl_days: 30 },
  ]

  it('skips disabled sources and open breakers', async () => {
    const pool = fakePool()
    const limiters = new Map([['a', new SourceRateLimiter(60)], ['c', new SourceRateLimiter(60)]])
    const breakers = new Map([['a', new CircuitBreaker()], ['c', new CircuitBreaker(1)]])
    breakers.get('c').recordFailure()  // open
    const parsers = { a: async () => [], c: async () => [] }
    const summary = await runWorkerTick(pool, { sources, parsers, limiters, breakers })
    expect(summary.find(s => s.source === 'c')?.skipped).toBe('breaker_open')
    expect(summary.find(s => s.source === 'b')).toBeUndefined()
  })

  it('runs parser, persists facts, marks done on success', async () => {
    const pool = fakePool({
      'UPDATE enrichment_jobs SET status=\'running\'': { rows: [{ id: 11, company_id: 99, source: 'a', attempt: 1 }], rowCount: 1 },
      'INSERT INTO company_facts': { rows: [], rowCount: 1 },
      'SET status=\'done\'': { rows: [], rowCount: 1 },
    })
    const limiters = new Map([['a', new SourceRateLimiter(60)]])
    const breakers = new Map([['a', new CircuitBreaker()]])
    const parsers = { a: vi.fn(async () => [{ field: 'x', value: 1 }]) }
    parsers.a.version = 'a_v1'
    const summary = await runWorkerTick(pool, { sources: [sources[0]], parsers, limiters, breakers })
    expect(parsers.a).toHaveBeenCalledWith(99)
    expect(summary[0]).toEqual({ source: 'a', ok: 1, failed: 0 })
    expect(breakers.get('a').failures).toBe(0)
  })

  it('on parser error: records failure + reschedules with backoff', async () => {
    const pool = fakePool({
      'UPDATE enrichment_jobs SET status=\'running\'': { rows: [{ id: 22, company_id: 99, source: 'a', attempt: 1 }], rowCount: 1 },
      'UPDATE enrichment_jobs SET status': { rows: [], rowCount: 1 },
    })
    const limiters = new Map([['a', new SourceRateLimiter(60)]])
    const breakers = new Map([['a', new CircuitBreaker(2)]])
    const parsers = { a: async () => { throw new Error('parser bug') } }
    const summary = await runWorkerTick(pool, { sources: [sources[0]], parsers, limiters, breakers })
    expect(summary[0]).toEqual({ source: 'a', ok: 0, failed: 1 })
    expect(breakers.get('a').failures).toBe(1)
    const failedCall = pool.calls.find(c => c.sql.includes('UPDATE enrichment_jobs SET status') && !c.sql.includes("'running'") && !c.sql.includes("'done'"))
    expect(failedCall).toBeDefined()
  })
})
