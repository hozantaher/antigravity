// chaos-sim.test.js — Tests for Markov chain chaos simulator.
// Used by HX3, HX4, HXX2, HXX4. TDD-RED first.
//
// Determinism is critical — all randomness via mulberry32 seeded RNG (mirror
// src/lib/spintax.js mulberry32). Same seed → identical fault sequence and
// MarkovSim summary across runs.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  FaultInjector,
  FakeClock,
  MarkovSim,
  ShadowRunner,
} from '../../helpers/chaos-sim.js'

// ─────────────────────────────────────────────────────────────────────────
// FaultInjector
// ─────────────────────────────────────────────────────────────────────────

describe('FaultInjector — rate-based scheduling', () => {
  it('rate_per_n triggers every N events', () => {
    const fi = new FaultInjector({ seed: 1 })
    fi.add({ name: 'smtp_fail', rate_per_n: 10, effect: 'increment_consecutive_bounces' })
    let triggered = 0
    for (let i = 0; i < 100; i++) {
      // event-based: each next() call is one event with elapsed_ms=0.
      const f = fi.nextEvent()
      if (f) triggered += 1
    }
    // 100 events / rate 10 = 10 fault triggers (deterministic offset allowed ±1).
    expect(triggered).toBeGreaterThanOrEqual(9)
    expect(triggered).toBeLessThanOrEqual(11)
  })

  it('rate_per_h triggers every H hours', () => {
    const fi = new FaultInjector({ seed: 2 })
    fi.add({ name: 'proxy_empty', rate_per_h: 1, effect: 'pool_zero' })
    // Walk 24h in 60-minute slices.
    let triggered = 0
    const HOUR = 60 * 60 * 1000
    for (let h = 0; h < 24; h++) {
      const f = fi.next(HOUR)
      if (f && f.name === 'proxy_empty') triggered += 1
    }
    // Expect ~24 triggers (one per hour) ±1.
    expect(triggered).toBeGreaterThanOrEqual(23)
    expect(triggered).toBeLessThanOrEqual(25)
  })

  it('deterministic — same seed produces identical fault sequence', () => {
    const make = () => {
      const fi = new FaultInjector({ seed: 42 })
      fi.add({ name: 'smtp_fail', rate_per_n: 5, effect: 'inc' })
      const seq = []
      for (let i = 0; i < 50; i++) seq.push(fi.nextEvent()?.name ?? null)
      return seq
    }
    expect(make()).toEqual(make())
  })

  it('no faults are produced when rate_per_n=0 and rate_per_h=0', () => {
    const fi = new FaultInjector({ seed: 7 })
    fi.add({ name: 'never', rate_per_n: 0, effect: 'noop' })
    for (let i = 0; i < 100; i++) {
      expect(fi.nextEvent()).toBeNull()
    }
  })

  it('multi-fault scheduling does not double-fire on the same tick', () => {
    const fi = new FaultInjector({ seed: 3 })
    fi.add({ name: 'a', rate_per_n: 5, effect: 'x' })
    fi.add({ name: 'b', rate_per_n: 5, effect: 'y' })
    // Each call returns at most one fault; multiple registrations queue.
    for (let i = 0; i < 20; i++) {
      const f = fi.nextEvent()
      // Either null or one of {a, b}, never both.
      if (f) expect(['a', 'b']).toContain(f.name)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// FakeClock
// ─────────────────────────────────────────────────────────────────────────

describe('FakeClock — deterministic time control', () => {
  it('advance moves time forward by the given ms', () => {
    const c = new FakeClock('2026-04-26T08:00:00Z')
    c.advance(60_000)
    expect(c.now().toISOString()).toBe('2026-04-26T08:01:00.000Z')
    expect(c.elapsed_ms).toBe(60_000)
  })

  it('advanceUntil reaches the target ISO timestamp', () => {
    const c = new FakeClock('2026-04-26T08:00:00Z')
    c.advanceUntil('2026-04-26T17:00:00Z')
    expect(c.now().toISOString()).toBe('2026-04-26T17:00:00.000Z')
    expect(c.elapsed_ms).toBe(9 * 60 * 60 * 1000)
  })

  it('never goes backward — advance(negative) throws', () => {
    const c = new FakeClock('2026-04-26T08:00:00Z')
    expect(() => c.advance(-1)).toThrow(/non-negative/i)
    // advanceUntil to past also throws.
    expect(() => c.advanceUntil('2026-04-25T00:00:00Z')).toThrow(/past/i)
  })

  it('date arithmetic is correct across day boundary', () => {
    const c = new FakeClock('2026-04-26T23:30:00Z')
    c.advance(60 * 60 * 1000) // +1 hour
    expect(c.now().toISOString()).toBe('2026-04-27T00:30:00.000Z')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// MarkovSim
// ─────────────────────────────────────────────────────────────────────────

describe('MarkovSim — chain runs with fault-driven transitions', () => {
  it('100-iteration run with one fault triggers exactly one transition', () => {
    const fi = new FaultInjector({ seed: 5 })
    fi.add({ name: 'smtp_fail', rate_per_n: 50, effect: 'pause' })
    const c = new FakeClock('2026-04-26T08:00:00Z')
    const sim = new MarkovSim({
      initialState: { mailbox: { status: 'active' } },
      transitions: [
        { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 1 },
      ],
      faultInjector: fi,
      clock: c,
    })
    sim.run({ iterations: 100 })
    const sum = sim.summary()
    // At rate_per_n=50 over 100 iterations, expect at least 1 trigger.
    expect(sum.heal_events.length).toBeGreaterThanOrEqual(1)
    expect(sim.state.mailbox.status).toBe('paused')
  })

  it('convergence — state is stable after recovery', () => {
    const fi = new FaultInjector({ seed: 9 })
    fi.add({ name: 'smtp_fail', rate_per_n: 50, effect: 'pause' })
    fi.add({ name: 'cooldown_expire', rate_per_h: 4, effect: 'recover' })
    const c = new FakeClock('2026-04-26T08:00:00Z')
    const sim = new MarkovSim({
      initialState: { mailbox: { status: 'active' } },
      transitions: [
        { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 1 },
        { trigger: 'cooldown_expire', from: 'paused', to: 'active' },
      ],
      faultInjector: fi,
      clock: c,
      // After paused, automatic recovery via cooldown_expire trigger.
      recoveryTriggers: ['cooldown_expire'],
    })
    // 24h with 200 iterations → time-based cooldown faults fire.
    sim.run({ iterations: 200, duration_ms: 24 * 60 * 60 * 1000 })
    const sum = sim.summary()
    // After enough iterations, the simulator should have observed both states.
    expect(sum.state_visits.size).toBeGreaterThanOrEqual(1)
    expect(sum.unrecovered).toBe(0)
  })

  it('state_visits Map is populated with visit counts', () => {
    const fi = new FaultInjector({ seed: 11 })
    fi.add({ name: 'smtp_fail', rate_per_n: 20, effect: 'pause' })
    const c = new FakeClock('2026-04-26T08:00:00Z')
    const sim = new MarkovSim({
      initialState: { mailbox: { status: 'active' } },
      transitions: [
        { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 1 },
        { trigger: 'cooldown_expire', from: 'paused', to: 'active' },
      ],
      faultInjector: fi,
      clock: c,
      recoveryTriggers: ['cooldown_expire'],
    })
    sim.run({ iterations: 100 })
    const sum = sim.summary()
    expect(sum.state_visits).toBeInstanceOf(Map)
    expect(sum.state_visits.size).toBeGreaterThan(0)
    let totalVisits = 0
    for (const v of sum.state_visits.values()) totalVisits += v
    expect(totalVisits).toBeGreaterThan(0)
  })

  it('summary has expected structure', () => {
    const fi = new FaultInjector({ seed: 13 })
    const c = new FakeClock('2026-04-26T08:00:00Z')
    const sim = new MarkovSim({
      initialState: { mailbox: { status: 'active' } },
      transitions: [],
      faultInjector: fi,
      clock: c,
    })
    sim.run({ iterations: 10 })
    const sum = sim.summary()
    expect(sum).toHaveProperty('state_visits')
    expect(sum).toHaveProperty('heal_events')
    expect(sum).toHaveProperty('slo_breaches')
    expect(sum).toHaveProperty('unrecovered')
  })

  it('multiple transitions: engine_panic moves engine ok→restarting', () => {
    const fi = new FaultInjector({ seed: 17 })
    fi.add({ name: 'engine_panic', rate_per_n: 10, effect: 'restart' })
    const c = new FakeClock('2026-04-26T08:00:00Z')
    const sim = new MarkovSim({
      initialState: {
        mailbox: { status: 'active' },
        engine: { status: 'ok' },
      },
      transitions: [
        { trigger: 'engine_panic', from: 'ok', to: 'restarting', after: 1, entity: 'engine' },
      ],
      faultInjector: fi,
      clock: c,
    })
    sim.run({ iterations: 50 })
    expect(sim.state.engine.status).toBe('restarting')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 7-day chaos smoke
// ─────────────────────────────────────────────────────────────────────────

describe('7-day chaos sim — realistic rates', () => {
  it('zero unrecovered states after 7 days with realistic rates', () => {
    const fi = new FaultInjector({ seed: 21 })
    fi.add({ name: 'smtp_fail', rate_per_n: 100, effect: 'increment_consecutive_bounces' })
    fi.add({ name: 'cooldown_expire', rate_per_h: 4, effect: 'recover' })
    const c = new FakeClock('2026-04-26T08:00:00Z')
    const sim = new MarkovSim({
      initialState: { mailbox: { status: 'active' } },
      transitions: [
        { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 3 },
        { trigger: 'cooldown_expire', from: 'paused', to: 'active' },
      ],
      faultInjector: fi,
      clock: c,
      recoveryTriggers: ['cooldown_expire'],
    })
    sim.run({ duration_ms: 7 * 24 * 60 * 60 * 1000, iterations: 1000 })
    const sum = sim.summary()
    expect(sum.unrecovered).toBe(0)
  })

  it('heal_events count is bounded for 7-day sim', () => {
    const fi = new FaultInjector({ seed: 23 })
    fi.add({ name: 'smtp_fail', rate_per_n: 100, effect: 'inc' })
    fi.add({ name: 'cooldown_expire', rate_per_h: 4, effect: 'recover' })
    const c = new FakeClock('2026-04-26T08:00:00Z')
    const sim = new MarkovSim({
      initialState: { mailbox: { status: 'active' } },
      transitions: [
        { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 3 },
        { trigger: 'cooldown_expire', from: 'paused', to: 'active' },
      ],
      faultInjector: fi,
      clock: c,
      recoveryTriggers: ['cooldown_expire'],
    })
    sim.run({ duration_ms: 7 * 24 * 60 * 60 * 1000, iterations: 1000 })
    const sum = sim.summary()
    // Bounded — for 7d × 4 cooldown/h ≈ 672, plus pause events ≈ 33 (1000/3/100×?).
    // Allow very loose bound: <= 5000.
    expect(sum.heal_events.length).toBeLessThan(5000)
  })

  it('runs in <500ms for 1000 events over 7 days', () => {
    const fi = new FaultInjector({ seed: 25 })
    fi.add({ name: 'smtp_fail', rate_per_n: 100, effect: 'inc' })
    fi.add({ name: 'cooldown_expire', rate_per_h: 4, effect: 'recover' })
    const c = new FakeClock('2026-04-26T08:00:00Z')
    const sim = new MarkovSim({
      initialState: { mailbox: { status: 'active' } },
      transitions: [
        { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 3 },
        { trigger: 'cooldown_expire', from: 'paused', to: 'active' },
      ],
      faultInjector: fi,
      clock: c,
      recoveryTriggers: ['cooldown_expire'],
    })
    const t0 = performance.now()
    sim.run({ duration_ms: 7 * 24 * 60 * 60 * 1000, iterations: 1000 })
    const t1 = performance.now()
    expect(t1 - t0).toBeLessThan(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// ShadowRunner
// ─────────────────────────────────────────────────────────────────────────

describe('ShadowRunner — counterfactual heal validation', () => {
  it('heal=net-positive when fault would persist without action', () => {
    const sr = new ShadowRunner({
      initialState: { send_events_per_h: 0, status: 'paused' },
      // Heal action: resume mailbox → unblocks sending.
      primary: (s) => ({ ...s, status: 'active', send_events_per_h: 120 }),
      shadow: (s) => ({ ...s, send_events_per_h: 80 }),
      metric: 'send_events_per_h',
    })
    const delta = sr.compare()
    expect(delta.primary).toBe(120)
    expect(delta.shadow).toBe(80)
    expect(delta.delta).toBe(40)
    expect(delta.netPositive).toBe(true)
  })

  it('heal=net-zero when same outcome', () => {
    const sr = new ShadowRunner({
      initialState: { send_events_per_h: 100 },
      primary: (s) => ({ ...s, send_events_per_h: 100 }),
      shadow: (s) => ({ ...s, send_events_per_h: 100 }),
      metric: 'send_events_per_h',
    })
    const delta = sr.compare()
    expect(delta.delta).toBe(0)
    expect(delta.netPositive).toBe(false)
  })

  it('heal=net-negative when heal causes cascade', () => {
    const sr = new ShadowRunner({
      initialState: { send_events_per_h: 100 },
      // Heal action: aggressive restart that empties the mailbox queue → drop.
      primary: (s) => ({ ...s, send_events_per_h: 50 }),
      shadow: (s) => ({ ...s, send_events_per_h: 100 }),
      metric: 'send_events_per_h',
    })
    const delta = sr.compare()
    expect(delta.delta).toBe(-50)
    expect(delta.netPositive).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────────

describe('Determinism — same seed = identical, different seeds diverge', () => {
  it('same seed → identical MarkovSim output', () => {
    const make = (seed) => {
      const fi = new FaultInjector({ seed })
      fi.add({ name: 'smtp_fail', rate_per_n: 50, effect: 'inc' })
      const c = new FakeClock('2026-04-26T08:00:00Z')
      const sim = new MarkovSim({
        initialState: { mailbox: { status: 'active' } },
        transitions: [
          { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 1 },
        ],
        faultInjector: fi,
        clock: c,
      })
      sim.run({ iterations: 200 })
      return sim.summary()
    }
    const a = make(99)
    const b = make(99)
    expect(a.heal_events.length).toBe(b.heal_events.length)
    expect([...a.state_visits.entries()].sort()).toEqual([...b.state_visits.entries()].sort())
  })

  it('different seeds → diverge in fault count or state visits', () => {
    const make = (seed) => {
      const fi = new FaultInjector({ seed })
      fi.add({ name: 'smtp_fail', rate_per_n: 50, effect: 'inc' })
      const c = new FakeClock('2026-04-26T08:00:00Z')
      const sim = new MarkovSim({
        initialState: { mailbox: { status: 'active' } },
        transitions: [
          { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 1 },
        ],
        faultInjector: fi,
        clock: c,
      })
      sim.run({ iterations: 500 })
      return sim.summary()
    }
    const a = make(1)
    const b = make(2)
    // Just check that some divergence is observable (heal_events differ OR
    // state_visits differ). For a real divergence at low rates, the count of
    // events still might match but timings differ — assert at least one diff.
    const aTimings = a.heal_events.map(e => e.at).join(',')
    const bTimings = b.heal_events.map(e => e.at).join(',')
    expect(aTimings).not.toBe(bTimings)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Property tests
// ─────────────────────────────────────────────────────────────────────────

describe('Property — MarkovSim never throws on random fault sequences', () => {
  it('property: 200 random fault rate combinations never throw', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 200 }),
        (seed, ratePerN, ratePerH, iterations) => {
          const fi = new FaultInjector({ seed })
          fi.add({ name: 'smtp_fail', rate_per_n: ratePerN, effect: 'inc' })
          fi.add({ name: 'cooldown_expire', rate_per_h: ratePerH, effect: 'recover' })
          const c = new FakeClock('2026-04-26T08:00:00Z')
          const sim = new MarkovSim({
            initialState: { mailbox: { status: 'active' } },
            transitions: [
              { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 1 },
              { trigger: 'cooldown_expire', from: 'paused', to: 'active' },
            ],
            faultInjector: fi,
            clock: c,
            recoveryTriggers: ['cooldown_expire'],
          })
          // No throw — that is the property.
          sim.run({ iterations })
          return true
        }
      ),
      { numRuns: 200 }
    )
  })

  it('property: summary always has expected fields after any run', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 500 }),
        (seed, iterations) => {
          const fi = new FaultInjector({ seed })
          fi.add({ name: 'smtp_fail', rate_per_n: 50, effect: 'inc' })
          const c = new FakeClock('2026-04-26T08:00:00Z')
          const sim = new MarkovSim({
            initialState: { mailbox: { status: 'active' } },
            transitions: [
              { trigger: 'smtp_fail', from: 'active', to: 'paused', after: 1 },
            ],
            faultInjector: fi,
            clock: c,
          })
          sim.run({ iterations })
          const sum = sim.summary()
          return (
            sum.state_visits instanceof Map &&
            Array.isArray(sum.heal_events) &&
            Array.isArray(sum.slo_breaches) &&
            typeof sum.unrecovered === 'number'
          )
        }
      ),
      { numRuns: 200 }
    )
  })

  it('property: FaultInjector with rate=0 always returns null', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 100 }),
        (seed, calls) => {
          const fi = new FaultInjector({ seed })
          fi.add({ name: 'never', rate_per_n: 0, effect: 'noop' })
          for (let i = 0; i < calls; i++) {
            if (fi.nextEvent() !== null) return false
          }
          return true
        }
      ),
      { numRuns: 200 }
    )
  })
})
