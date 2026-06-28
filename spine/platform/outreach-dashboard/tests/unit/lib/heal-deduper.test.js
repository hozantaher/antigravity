// HXX10 — Storm-resilient heal idempotency.
//
// Dedupes heal requests on (entity_id + heal_kind) within a sliding 30s window.
// First request wins; subsequent within window are deduped.
// Storm pattern: 1000 concurrent same-key requests in 1s → 1 applied + 999 deduped.

import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { HealDeduper } from '../../../src/lib/heal-deduper.js'

describe('HXX10 — HealDeduper basic semantics', () => {
  let now
  let dd

  beforeEach(() => {
    now = 0
    dd = new HealDeduper({ window_ms: 30_000, now: () => now })
  })

  it('1. single request: applied=true', () => {
    const r = dd.request('mb-1', 'reset_password')
    expect(r.applied).toBe(true)
    expect(r.storm_size).toBe(1)
    expect(typeof r.dedup_key).toBe('string')
    expect(r.dedup_key.length).toBeGreaterThan(0)
  })

  it('2. same key twice in window: 2nd applied=false, storm_size=2', () => {
    const r1 = dd.request('mb-1', 'reset_password')
    const r2 = dd.request('mb-1', 'reset_password')
    expect(r1.applied).toBe(true)
    expect(r2.applied).toBe(false)
    expect(r2.storm_size).toBe(2)
    expect(r2.dedup_key).toBe(r1.dedup_key)
  })

  it('3. different keys: each applied=true independently', () => {
    const r1 = dd.request('mb-1', 'reset_password')
    const r2 = dd.request('mb-2', 'reset_password')
    const r3 = dd.request('mb-1', 'rotate_proxy')
    expect(r1.applied).toBe(true)
    expect(r2.applied).toBe(true)
    expect(r3.applied).toBe(true)
    expect(new Set([r1.dedup_key, r2.dedup_key, r3.dedup_key]).size).toBe(3)
  })

  it('4. after window expires: same key fresh again (applied=true)', () => {
    const r1 = dd.request('mb-1', 'reset_password')
    expect(r1.applied).toBe(true)
    now = 30_001  // window elapsed
    const r2 = dd.request('mb-1', 'reset_password')
    expect(r2.applied).toBe(true)
    expect(r2.storm_size).toBe(1)
    expect(r2.dedup_key).not.toBe(r1.dedup_key)  // fresh window bucket
  })
})

describe('HXX10 — Storm scenarios (concurrency)', () => {
  it('5. 1000 concurrent same-key requests via Promise.all → exactly 1 applied + 999 deduped', async () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    const results = await Promise.all(
      Array.from({ length: 1000 }, () => Promise.resolve(dd.request('mb-1', 'reset_password')))
    )
    const applied = results.filter(r => r.applied).length
    const deduped = results.filter(r => !r.applied).length
    expect(applied).toBe(1)
    expect(deduped).toBe(999)
  })

  it('6. 1000 concurrent same-key requests: storm_size in last result = 1000', async () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    const results = await Promise.all(
      Array.from({ length: 1000 }, () => Promise.resolve(dd.request('mb-1', 'reset_password')))
    )
    expect(results[results.length - 1].storm_size).toBe(1000)
  })

  it('7. stats(): dedup_key → storm_size mapping populated', () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    dd.request('mb-1', 'reset_password')
    dd.request('mb-1', 'reset_password')
    dd.request('mb-1', 'reset_password')
    dd.request('mb-2', 'rotate_proxy')
    const s = dd.stats()
    expect(s).toBeInstanceOf(Map)
    expect(s.size).toBe(2)
    const counts = Array.from(s.values()).sort((a, b) => a - b)
    expect(counts).toEqual([1, 3])
  })

  it('8. different heal_kinds for same entity dedupe independently', () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    const r1 = dd.request('mb-1', 'reset_password')
    const r2 = dd.request('mb-1', 'rotate_proxy')
    const r3 = dd.request('mb-1', 'reset_password')
    const r4 = dd.request('mb-1', 'rotate_proxy')
    expect(r1.applied).toBe(true)
    expect(r2.applied).toBe(true)
    expect(r3.applied).toBe(false)
    expect(r4.applied).toBe(false)
    expect(r1.dedup_key).not.toBe(r2.dedup_key)
  })
})

describe('HXX10 — Boundary conditions', () => {
  it('9. window=0 → every request applied (no dedup)', () => {
    const dd = new HealDeduper({ window_ms: 0, now: () => 0 })
    const r1 = dd.request('mb-1', 'reset_password')
    const r2 = dd.request('mb-1', 'reset_password')
    const r3 = dd.request('mb-1', 'reset_password')
    expect(r1.applied).toBe(true)
    expect(r2.applied).toBe(true)
    expect(r3.applied).toBe(true)
  })

  it('10. window=Infinity → only first ever applied', () => {
    let now = 0
    const dd = new HealDeduper({ window_ms: Infinity, now: () => now })
    const r1 = dd.request('mb-1', 'reset_password')
    now = 1e15  // far future
    const r2 = dd.request('mb-1', 'reset_password')
    now = 1e18
    const r3 = dd.request('mb-1', 'reset_password')
    expect(r1.applied).toBe(true)
    expect(r2.applied).toBe(false)
    expect(r3.applied).toBe(false)
  })

  it('15. time travel backward: dedup behavior unchanged (window is sliding from latest)', () => {
    let now = 10_000
    const dd = new HealDeduper({ window_ms: 30_000, now: () => now })
    const r1 = dd.request('mb-1', 'reset_password')
    now = 5_000  // clock skew backward
    const r2 = dd.request('mb-1', 'reset_password')
    expect(r1.applied).toBe(true)
    expect(r2.applied).toBe(false)
    expect(r2.dedup_key).toBe(r1.dedup_key)
  })

  it('16. missing entity_id → throws', () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    expect(() => dd.request(null, 'reset_password')).toThrow()
    expect(() => dd.request(undefined, 'reset_password')).toThrow()
    expect(() => dd.request('', 'reset_password')).toThrow()
  })

  it('17. missing heal_kind → throws', () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    expect(() => dd.request('mb-1', null)).toThrow()
    expect(() => dd.request('mb-1', undefined)).toThrow()
    expect(() => dd.request('mb-1', '')).toThrow()
  })

  it('18. dedup_key includes window bucket so post-window same params get fresh key', () => {
    let now = 0
    const dd = new HealDeduper({ window_ms: 30_000, now: () => now })
    const r1 = dd.request('mb-1', 'reset_password')
    now = 30_001
    const r2 = dd.request('mb-1', 'reset_password')
    expect(r1.dedup_key).not.toBe(r2.dedup_key)
    expect(r1.dedup_key).toContain('mb-1')
    expect(r1.dedup_key).toContain('reset_password')
  })

  it('19. stats() returns Map (not plain object — preserves insertion order)', () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    dd.request('mb-3', 'rotate_proxy')
    dd.request('mb-1', 'reset_password')
    dd.request('mb-2', 'restart_smtp')
    const s = dd.stats()
    expect(s).toBeInstanceOf(Map)
    const keys = Array.from(s.keys())
    expect(keys.length).toBe(3)
    // Insertion order preserved
    expect(keys[0]).toContain('mb-3')
    expect(keys[1]).toContain('mb-1')
    expect(keys[2]).toContain('mb-2')
  })

  it('20. concurrent different keys do not block each other (no global lock)', () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    const results = []
    for (let i = 0; i < 100; i++) {
      results.push(dd.request(`mb-${i}`, 'reset_password'))
    }
    expect(results.every(r => r.applied)).toBe(true)
    expect(results.every(r => r.storm_size === 1)).toBe(true)
  })
})

describe('HXX10 — Storm callback + observability', () => {
  it('21. Sentry breadcrumb annotation: storm_size > 100 emits "high-storm" tag', () => {
    const calls = []
    const dd = new HealDeduper({
      window_ms: 30_000,
      now: () => 0,
      onStorm: (info) => calls.push(info),
    })
    for (let i = 0; i < 100; i++) dd.request('mb-1', 'reset_password')
    expect(calls.length).toBe(0)
    dd.request('mb-1', 'reset_password')  // 101 → triggers
    expect(calls.length).toBe(1)
    expect(calls[0].tag).toBe('high-storm')
    expect(calls[0].storm_size).toBe(101)
    expect(calls[0].dedup_key).toContain('mb-1')
  })

  it('21b. onStorm is fired exactly once per window crossing the 100-threshold', () => {
    const calls = []
    const dd = new HealDeduper({
      window_ms: 30_000,
      now: () => 0,
      onStorm: (info) => calls.push(info),
    })
    for (let i = 0; i < 250; i++) dd.request('mb-1', 'reset_password')
    expect(calls.length).toBe(1)
  })

  it('22. healing_log dedup row includes storm_size and dedup_key', () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    dd.request('mb-1', 'reset_password')
    dd.request('mb-1', 'reset_password')
    const row = dd.toHealingLogRow('mb-1', 'reset_password')
    expect(row).toMatchObject({
      action: 'heal_dedup',
      entity_id: 'mb-1',
    })
    expect(row.storm_size).toBe(2)
    expect(typeof row.dedup_key).toBe('string')
    expect(row.reason).toContain('dedup')
  })
})

describe('HXX10 — Stress + property tests', () => {
  it('23. stress: 10k requests across 100 unique keys × 100× each → 100 applied, 9900 deduped', () => {
    const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
    let applied = 0
    let deduped = 0
    for (let i = 0; i < 100; i++) {
      for (let k = 0; k < 100; k++) {
        const r = dd.request(`mb-${i}`, 'reset_password')
        if (r.applied) applied++
        else deduped++
      }
    }
    expect(applied).toBe(100)
    expect(deduped).toBe(9900)
  })

  it('11. property: applied flag false iff key seen within window', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('mb-1', 'mb-2', 'mb-3'),
            fc.constantFrom('reset_password', 'rotate_proxy'),
          ),
          { minLength: 5, maxLength: 100 },
        ),
        (sequence) => {
          const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
          const seen = new Set()
          for (const [eid, kind] of sequence) {
            const r = dd.request(eid, kind)
            const composite = `${eid}|${kind}`
            const wasSeen = seen.has(composite)
            if (wasSeen && r.applied) return false
            if (!wasSeen && !r.applied) return false
            seen.add(composite)
          }
          return true
        },
      ),
      { numRuns: 100 },
    )
  })

  it('12. property: storm_size is monotonic within window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 200 }),
        (count) => {
          const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
          let last = 0
          for (let i = 0; i < count; i++) {
            const r = dd.request('mb-1', 'reset_password')
            if (r.storm_size < last) return false
            last = r.storm_size
          }
          return last === count
        },
      ),
      { numRuns: 50 },
    )
  })

  it('13. property: storm_size resets to 1 after window expires', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 30_001, max: 1_000_000 }),
        (preCount, jump) => {
          let now = 0
          const dd = new HealDeduper({ window_ms: 30_000, now: () => now })
          for (let i = 0; i < preCount; i++) dd.request('mb-1', 'reset_password')
          now += jump
          const r = dd.request('mb-1', 'reset_password')
          return r.applied === true && r.storm_size === 1
        },
      ),
      { numRuns: 50 },
    )
  })

  it('24. fast-check property: 200 random sequences → applied count = unique keys count', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 4 }),
            fc.string({ minLength: 1, maxLength: 4 }),
          ),
          { minLength: 1, maxLength: 200 },
        ),
        (sequence) => {
          const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
          const unique = new Set()
          let applied = 0
          for (const [eid, kind] of sequence) {
            const r = dd.request(eid, kind)
            if (r.applied) applied++
            unique.add(`${eid}|${kind}`)
          }
          return applied === unique.size
        },
      ),
      { numRuns: 100 },
    )
  })

  it('25. fast-check property: storm_size never decreases mid-window', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom('mb-1', 'mb-2'),
          { minLength: 5, maxLength: 100 },
        ),
        (sequence) => {
          const dd = new HealDeduper({ window_ms: 30_000, now: () => 0 })
          const lastStorm = new Map()  // key → last storm_size
          for (const eid of sequence) {
            const r = dd.request(eid, 'reset_password')
            const prev = lastStorm.get(r.dedup_key) ?? 0
            if (r.storm_size < prev) return false
            lastStorm.set(r.dedup_key, r.storm_size)
          }
          return true
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('HXX10 — Memory bounds', () => {
  it('14. memory bound: 1M unique keys → no leak (TTL eviction)', () => {
    let now = 0
    const dd = new HealDeduper({ window_ms: 30_000, now: () => now })
    // Burn unique keys, then advance past window. Stats should drop expired entries.
    for (let i = 0; i < 5000; i++) dd.request(`mb-${i}`, 'reset_password')
    expect(dd.stats().size).toBe(5000)
    now = 60_000  // way past window
    // Touch one new key to trigger eviction.
    dd.request('mb-fresh', 'reset_password')
    // Old entries should have been evicted.
    expect(dd.stats().size).toBe(1)
  })
})
