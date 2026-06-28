// HX6 — Concurrent heal-action coordination tests (≥20 cases).
//
// Models pg_try_advisory_lock(mb_id) semantics: when 100 concurrent heal
// attempts target the same mailbox, exactly one must win and run the
// healer; the rest must skip cleanly without blocking. Stale-lock release
// covers the "holder crashed before release()" path that the Postgres
// implementation gets via session-bound locks.
//
// This is a JS fixture for testing the SEMANTIC, not a replacement for
// real pg_try_advisory_lock — production code uses scheduler_postgres.go.
//
// Buckets:
//   1..8   tryAcquire / release primitives
//   9..12  runUnderLock under load
//   13..17 input validation + propagation
//   18..21 property tests + stress / leak guard

import { describe, it, expect, beforeEach } from 'vitest'
import fc from 'fast-check'
import { HealCoordinator } from '../../../src/lib/heal-coordinator.js'

describe('HealCoordinator — primitives', () => {
  let coord
  beforeEach(() => {
    coord = new HealCoordinator()
  })

  // 1
  it('tryAcquire on empty coordinator succeeds', () => {
    const res = coord.tryAcquire('mb-1', 'holder-A')
    expect(res.acquired).toBe(true)
    expect(coord.size()).toBe(1)
  })

  // 2
  it('tryAcquire same entity twice with different holders: 2nd fails', () => {
    const first = coord.tryAcquire('mb-1', 'holder-A')
    const second = coord.tryAcquire('mb-1', 'holder-B')
    expect(first.acquired).toBe(true)
    expect(second.acquired).toBe(false)
    expect(second.holderId).toBe('holder-A')
  })

  // 3
  it('release allows re-acquire (by same or different holder)', () => {
    coord.tryAcquire('mb-1', 'holder-A')
    coord.release('mb-1', 'holder-A')
    const res = coord.tryAcquire('mb-1', 'holder-B')
    expect(res.acquired).toBe(true)
  })

  // 4
  it('release with wrong holder is no-op (owner stays)', () => {
    coord.tryAcquire('mb-1', 'holder-A')
    coord.release('mb-1', 'holder-X')
    const res = coord.tryAcquire('mb-1', 'holder-B')
    expect(res.acquired).toBe(false)
    expect(res.holderId).toBe('holder-A')
  })

  // 5
  it('release on unheld entity is no-op (does not throw)', () => {
    expect(() => coord.release('mb-unknown', 'holder-A')).not.toThrow()
    expect(coord.size()).toBe(0)
  })

  // 6
  it('different entities never block each other', () => {
    expect(coord.tryAcquire('mb-1', 'A').acquired).toBe(true)
    expect(coord.tryAcquire('mb-2', 'A').acquired).toBe(true)
    expect(coord.tryAcquire('mb-3', 'A').acquired).toBe(true)
    expect(coord.size()).toBe(3)
  })

  // 7
  it('same holder re-acquiring its own lock returns acquired=false (non-reentrant)', () => {
    coord.tryAcquire('mb-1', 'holder-A')
    const res = coord.tryAcquire('mb-1', 'holder-A')
    // pg_try_advisory_lock IS reentrant by session, but our fixture
    // models the heal-coordination semantic where the second attempt
    // is a competitor that must skip. Document via assertion.
    expect(res.acquired).toBe(false)
    expect(res.holderId).toBe('holder-A')
  })

  // 8
  it('size() reflects current held locks across acquire+release', () => {
    expect(coord.size()).toBe(0)
    coord.tryAcquire('mb-1', 'A')
    coord.tryAcquire('mb-2', 'A')
    expect(coord.size()).toBe(2)
    coord.release('mb-1', 'A')
    expect(coord.size()).toBe(1)
    coord.release('mb-2', 'A')
    expect(coord.size()).toBe(0)
  })
})

describe('HealCoordinator — runUnderLock', () => {
  let coord
  beforeEach(() => {
    coord = new HealCoordinator()
  })

  // 9
  it('runUnderLock executes fn when free', async () => {
    let executed = false
    const result = await coord.runUnderLock('mb-1', 'A', async () => {
      executed = true
      return 'ok'
    })
    expect(executed).toBe(true)
    expect(result.skipped).toBeFalsy()
    expect(result.value).toBe('ok')
  })

  // 10
  it('runUnderLock skips when held by another holder', async () => {
    coord.tryAcquire('mb-1', 'A')
    let executed = false
    const result = await coord.runUnderLock('mb-1', 'B', async () => {
      executed = true
    })
    expect(executed).toBe(false)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBeTruthy()
  })

  // 11
  it('runUnderLock auto-releases after fn completes', async () => {
    await coord.runUnderLock('mb-1', 'A', async () => {})
    expect(coord.size()).toBe(0)
    const res = coord.tryAcquire('mb-1', 'B')
    expect(res.acquired).toBe(true)
  })

  // 12
  it('100 concurrent runUnderLock for same entity → exactly 1 fn execution', async () => {
    let runCount = 0
    const winners = []
    const promises = Array.from({ length: 100 }, (_, i) =>
      coord.runUnderLock('mb-shared', `holder-${i}`, async () => {
        runCount += 1
        winners.push(`holder-${i}`)
        // tiny async gap so we'd race if locking didn't work
        await new Promise(r => setTimeout(r, 0))
      }),
    )
    const results = await Promise.all(promises)
    expect(runCount).toBe(1)
    expect(winners).toHaveLength(1)
    const skipped = results.filter(r => r.skipped).length
    expect(skipped).toBe(99)
    expect(coord.size()).toBe(0)
  })

  // 13
  it('100 concurrent runUnderLock for 100 distinct entities → all 100 fns execute', async () => {
    let runCount = 0
    const promises = Array.from({ length: 100 }, (_, i) =>
      coord.runUnderLock(`mb-${i}`, `holder-${i}`, async () => {
        runCount += 1
        await new Promise(r => setTimeout(r, 0))
      }),
    )
    const results = await Promise.all(promises)
    expect(runCount).toBe(100)
    expect(results.every(r => !r.skipped)).toBe(true)
    expect(coord.size()).toBe(0)
  })

  // 14
  it('runUnderLock auto-releases after fn throws synchronously (always release)', async () => {
    await expect(
      coord.runUnderLock('mb-1', 'A', () => {
        throw new Error('boom-sync')
      }),
    ).rejects.toThrow('boom-sync')
    expect(coord.size()).toBe(0)
    expect(coord.tryAcquire('mb-1', 'B').acquired).toBe(true)
  })

  // 15
  it('runUnderLock auto-releases after fn rejects async', async () => {
    await expect(
      coord.runUnderLock('mb-1', 'A', async () => {
        throw new Error('boom-async')
      }),
    ).rejects.toThrow('boom-async')
    expect(coord.size()).toBe(0)
    expect(coord.tryAcquire('mb-1', 'B').acquired).toBe(true)
  })
})

describe('HealCoordinator — stale lock recovery', () => {
  let coord
  beforeEach(() => {
    coord = new HealCoordinator()
  })

  // 16
  it('tryAcquire on stale lock (older than maxAge) → succeeds when called with explicit now', () => {
    // The coordinator records acquiredAt at acquire time. We rely on
    // releaseStale(maxAgeMs, now) to evict.
    const t0 = 1_000_000
    coord.tryAcquire('mb-1', 'A', t0)
    const evicted = coord.releaseStale(60_000, t0 + 60_001)
    expect(evicted).toBe(1)
    const res = coord.tryAcquire('mb-1', 'B', t0 + 60_002)
    expect(res.acquired).toBe(true)
  })

  // 17
  it('releaseStale evicts old locks but keeps fresh ones', () => {
    coord.tryAcquire('mb-old', 'A', 1_000)
    coord.tryAcquire('mb-fresh', 'B', 1_000_000)
    const evicted = coord.releaseStale(60_000, 1_001_000)
    expect(evicted).toBe(1)
    expect(coord.size()).toBe(1)
    // fresh one still held
    expect(coord.tryAcquire('mb-fresh', 'C', 1_001_000).acquired).toBe(false)
    // old one freed
    expect(coord.tryAcquire('mb-old', 'C', 1_001_000).acquired).toBe(true)
  })
})

describe('HealCoordinator — input validation', () => {
  let coord
  beforeEach(() => {
    coord = new HealCoordinator()
  })

  // 18
  it('null / undefined holderId throws', () => {
    expect(() => coord.tryAcquire('mb-1', null)).toThrow()
    expect(() => coord.tryAcquire('mb-1', undefined)).toThrow()
    expect(() => coord.tryAcquire('mb-1', '')).toThrow()
  })

  // 19
  it('null / undefined entityId throws', () => {
    expect(() => coord.tryAcquire(null, 'A')).toThrow()
    expect(() => coord.tryAcquire(undefined, 'A')).toThrow()
    expect(() => coord.tryAcquire('', 'A')).toThrow()
  })

  // 20
  it('two holders attempting acquire simultaneously: only one wins', async () => {
    // Synchronous tryAcquire is the race-free primitive — async wrappers
    // serialize through the JS event loop. Drain the microtask queue
    // to assert no torn state.
    const r1 = coord.tryAcquire('mb-race', 'X')
    const r2 = coord.tryAcquire('mb-race', 'Y')
    expect([r1.acquired, r2.acquired].filter(Boolean)).toHaveLength(1)
    expect(coord.size()).toBe(1)
  })
})

describe('HealCoordinator — property tests', () => {
  // 21
  it('property: 200 random orderings of acquire/release never desynchronize size()', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            op: fc.constantFrom('acquire', 'release'),
            entity: fc.constantFrom('e1', 'e2', 'e3', 'e4', 'e5'),
            holder: fc.constantFrom('h1', 'h2', 'h3'),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        ops => {
          const c = new HealCoordinator()
          // Track expected held locks ourselves.
          const held = new Map() // entity → holder
          for (const { op, entity, holder } of ops) {
            if (op === 'acquire') {
              const res = c.tryAcquire(entity, holder)
              if (!held.has(entity)) {
                if (!res.acquired) return false
                held.set(entity, holder)
              } else {
                if (res.acquired) return false
              }
            } else {
              c.release(entity, holder)
              if (held.get(entity) === holder) {
                held.delete(entity)
              }
            }
            if (c.size() !== held.size) return false
          }
          return true
        },
      ),
      { numRuns: 200 },
    )
  })

  // 22
  it('property: storm of 1000 acquire-with-skip → exactly 1 winner per (entity, generation)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }), // distinct entities
        fc.integer({ min: 1, max: 1000 }), // total attempts
        (numEntities, totalAttempts) => {
          const c = new HealCoordinator()
          const winners = new Map() // entity → holder
          for (let i = 0; i < totalAttempts; i++) {
            const entity = `e-${i % numEntities}`
            const holder = `h-${i}`
            const res = c.tryAcquire(entity, holder)
            if (res.acquired) {
              if (winners.has(entity)) return false // double-win same generation
              winners.set(entity, holder)
            }
          }
          // Without releases, every entity that was attempted has exactly one winner.
          const attemptedEntities = Math.min(numEntities, totalAttempts)
          if (winners.size !== attemptedEntities) return false
          if (c.size() !== attemptedEntities) return false
          return true
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('HealCoordinator — stress / leak', () => {
  // 23
  it('10000 sequential acquire-release cycles → no leak in locks Map', () => {
    const c = new HealCoordinator()
    for (let i = 0; i < 10_000; i++) {
      const e = `e-${i % 17}`
      c.tryAcquire(e, 'A')
      c.release(e, 'A')
    }
    expect(c.size()).toBe(0)
  })
})
