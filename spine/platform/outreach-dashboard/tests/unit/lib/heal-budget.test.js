// HX7 — Cost-aware heal budget (token bucket).
// Each heal-action consumes a token. Refills 30/h per-mailbox, 1000/h system.
// Over budget → action deferred to next bucket + log "heal_throttled".

import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import {
  TokenBucket,
  HealBudget,
} from '../../../src/lib/heal-budget.js'

describe('HX7 — TokenBucket primitive', () => {
  it('initial state: capacity tokens available', () => {
    const b = new TokenBucket({ capacity: 10, refillPerHour: 30, now: () => 0 })
    expect(b.available()).toBe(10)
  })

  it('consume reduces available by N', () => {
    const b = new TokenBucket({ capacity: 10, refillPerHour: 30, now: () => 0 })
    expect(b.consume(3)).toBe(true)
    expect(b.available()).toBe(7)
  })

  it('consume returns false when insufficient tokens', () => {
    const b = new TokenBucket({ capacity: 5, refillPerHour: 30, now: () => 0 })
    expect(b.consume(6)).toBe(false)
    expect(b.available()).toBe(5)
  })

  it('refill: 30 tokens/h = 0.5/min — after 60 min, +30 tokens (capped)', () => {
    let now = 0
    const b = new TokenBucket({ capacity: 30, refillPerHour: 30, now: () => now })
    b.consume(30)
    expect(b.available()).toBe(0)
    now = 60 * 60 * 1000  // +1h
    expect(b.available()).toBe(30)  // refilled to capacity
  })

  it('refill caps at capacity (no overflow)', () => {
    let now = 0
    const b = new TokenBucket({ capacity: 10, refillPerHour: 60, now: () => now })
    b.consume(5)
    now = 24 * 60 * 60 * 1000
    expect(b.available()).toBe(10)
  })

  it('partial refill: half-hour gives half-rate', () => {
    let now = 0
    const b = new TokenBucket({ capacity: 30, refillPerHour: 30, now: () => now })
    b.consume(30)
    now = 30 * 60 * 1000  // +30min
    expect(b.available()).toBe(15)
  })

  it('total_emitted invariant: tokens_consumed + tokens_remaining = tokens emitted', () => {
    const b = new TokenBucket({ capacity: 100, refillPerHour: 0, now: () => 0 })
    let consumed = 0
    consumed += b.consume(20) ? 20 : 0
    consumed += b.consume(30) ? 30 : 0
    consumed += b.consume(40) ? 40 : 0
    consumed += b.consume(50) ? 50 : 0  // should fail (only 10 left)
    const remaining = b.available()
    // 100 emitted = consumed + remaining
    expect(consumed + remaining).toBe(100)
  })

  it('available never negative', () => {
    const b = new TokenBucket({ capacity: 5, refillPerHour: 30, now: () => 0 })
    b.consume(3)
    b.consume(3)
    b.consume(3)
    expect(b.available()).toBeGreaterThanOrEqual(0)
  })

  it('consume(0) is a no-op (idempotent)', () => {
    const b = new TokenBucket({ capacity: 10, refillPerHour: 30, now: () => 0 })
    expect(b.consume(0)).toBe(true)
    expect(b.available()).toBe(10)
  })
})

describe('HX7 — HealBudget composition (per-entity + system)', () => {
  let now
  let bg

  beforeEach(() => {
    now = 0
    bg = new HealBudget({ perEntityHourly: 30, systemHourly: 1000, now: () => now })
  })

  it('first heal action allowed', () => {
    expect(bg.allow('mb=1', 1)).toBe(true)
  })

  it('per-entity exhaustion: 31st action denied', () => {
    for (let i = 0; i < 30; i++) bg.allow('mb=1', 1)
    expect(bg.allow('mb=1', 1)).toBe(false)
  })

  it('per-entity exhausted but other entity still allowed', () => {
    for (let i = 0; i < 30; i++) bg.allow('mb=1', 1)
    expect(bg.allow('mb=1', 1)).toBe(false)
    expect(bg.allow('mb=2', 1)).toBe(true)
  })

  it('system exhaustion: ~33 mailboxes hit, 34th denied even with fresh per-entity', () => {
    // 1000 system / 30 per-mb = 33.3 → 34th mailbox blocks at system
    for (let mb = 1; mb <= 35; mb++) {
      for (let n = 0; n < 30; n++) bg.allow(`mb=${mb}`, 1)
    }
    // Now system bucket should be exhausted (35 × 30 = 1050 attempts, 1000 capacity)
    expect(bg.allow('mb=99', 1)).toBe(false)
  })

  it('1h tick refills system + per-entity', () => {
    for (let i = 0; i < 30; i++) bg.allow('mb=1', 1)
    expect(bg.allow('mb=1', 1)).toBe(false)
    now = 60 * 60 * 1000
    expect(bg.allow('mb=1', 1)).toBe(true)
  })

  it('heal_throttled emitted when allow returns false', () => {
    for (let i = 0; i < 30; i++) bg.allow('mb=1', 1)
    const log = []
    bg.onThrottle = (entry) => log.push(entry)
    bg.allow('mb=1', 1)
    expect(log.length).toBe(1)
    expect(log[0]).toMatchObject({ entity: 'mb=1', kind: 'heal_throttled' })
  })

  it('healthy mb not starved when neighbor under attack', () => {
    // mb=1 burns its budget rapidly
    for (let i = 0; i < 50; i++) bg.allow('mb=1', 1)
    // mb=2 still has its full budget
    expect(bg.allow('mb=2', 1)).toBe(true)
    let okCount = 1
    for (let i = 0; i < 29; i++) if (bg.allow('mb=2', 1)) okCount++
    expect(okCount).toBe(30)
  })

  it('property: token sum across all entities never exceeds emitted', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 5 }), fc.integer({ min: 1, max: 5 })),
          { minLength: 5, maxLength: 50 }
        ),
        (sequence) => {
          const b = new HealBudget({ perEntityHourly: 10, systemHourly: 100, now: () => 0 })
          let consumed = 0
          for (const [ent, n] of sequence) {
            if (b.allow(ent, n)) consumed += n
          }
          return consumed <= 100
        }
      ),
      { numRuns: 100 }
    )
  })

  it('boundary: capacity=0 always denies', () => {
    const b = new HealBudget({ perEntityHourly: 0, systemHourly: 0, now: () => 0 })
    expect(b.allow('mb=1', 1)).toBe(false)
  })

  it('entity tracking: stats() reports per-entity consumption', () => {
    bg.allow('mb=1', 5)
    bg.allow('mb=2', 3)
    const stats = bg.stats()
    expect(stats['mb=1']).toBe(5)
    expect(stats['mb=2']).toBe(3)
  })

  it('consume(N>capacity) atomically denies (no partial)', () => {
    // Per-entity capacity is 30; ask for 31 → all-or-nothing
    expect(bg.allow('mb=1', 31)).toBe(false)
    expect(bg.stats()['mb=1'] || 0).toBe(0)
  })

  it('time travel backward: bucket caps at capacity (no negative refill)', () => {
    bg.allow('mb=1', 30)
    now = -1000  // simulate clock skew backward
    expect(bg.allow('mb=1', 1)).toBe(false)
  })

  it('refill window aligned to hour boundaries (sliding)', () => {
    bg.allow('mb=1', 30)
    now = 30 * 60 * 1000  // +30min
    expect(bg.allow('mb=1', 1)).toBe(true)  // 15 refilled, 1 consumed → 14 left
  })

  it('long idle: full refill possible', () => {
    bg.allow('mb=1', 30)
    now = 24 * 60 * 60 * 1000  // +24h
    let okCount = 0
    for (let i = 0; i < 35; i++) if (bg.allow('mb=1', 1)) okCount++
    expect(okCount).toBe(30)  // capped at capacity
  })

  it('property: throttle log size = denied count', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 5 })),
          { minLength: 5, maxLength: 100 }
        ),
        (sequence) => {
          const b = new HealBudget({ perEntityHourly: 10, systemHourly: 50, now: () => 0 })
          let denied = 0
          let throttled = 0
          b.onThrottle = () => throttled++
          for (const [ent, n] of sequence) {
            if (!b.allow(ent, n)) denied++
          }
          return denied === throttled
        }
      ),
      { numRuns: 100 }
    )
  })
})
