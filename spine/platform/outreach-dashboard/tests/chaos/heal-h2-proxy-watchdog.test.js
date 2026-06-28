// H2 — Proxy pool empty-streak watchdog recovery.
//
// Production semantics (features/outreach/relay/internal/transport/proxy_pool.go):
//   ConsecutiveZeroRefreshes counter increments on each refresh that returns
//   0 proxies. When ≥3, pool is `empty_pool_critical=true`. Next non-zero
//   refresh resets counter to 0; critical clears.
//
// This test models that state machine via heal-fixtures and asserts:
//   - counter monotonic until reset
//   - critical flag tracks counter≥3
//   - reset only on non-zero refresh
//   - never gets stuck (single non-zero clears critical)

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { assertMonotonic, assertNoStateOscillation } from '../helpers/slo-helpers.js'

// Lightweight proxy pool watchdog model — pure data, no I/O.
function makeProxyPoolWatchdog() {
  let counter = 0
  const trace = []
  return {
    refresh(proxyCount) {
      if (proxyCount === 0) counter++
      else counter = 0
      trace.push({ proxyCount, counter, critical: counter >= 3 })
      return { counter, critical: counter >= 3 }
    },
    get state() { return { counter, critical: counter >= 3 } },
    get trace() { return [...trace] },
  }
}

describe('H2 — Proxy pool watchdog: counter behavior', () => {
  it('initial state: counter=0, not critical', () => {
    const w = makeProxyPoolWatchdog()
    expect(w.state.counter).toBe(0)
    expect(w.state.critical).toBe(false)
  })

  it('1 zero refresh: counter=1, not critical', () => {
    const w = makeProxyPoolWatchdog()
    w.refresh(0)
    expect(w.state.counter).toBe(1)
    expect(w.state.critical).toBe(false)
  })

  it('2 zero refreshes: counter=2, not critical', () => {
    const w = makeProxyPoolWatchdog()
    w.refresh(0)
    w.refresh(0)
    expect(w.state.critical).toBe(false)
  })

  it('3 consecutive zero refreshes: critical=true', () => {
    const w = makeProxyPoolWatchdog()
    w.refresh(0)
    w.refresh(0)
    w.refresh(0)
    expect(w.state.critical).toBe(true)
    expect(w.state.counter).toBe(3)
  })

  it('5 consecutive zeros: counter=5, still critical', () => {
    const w = makeProxyPoolWatchdog()
    for (let i = 0; i < 5; i++) w.refresh(0)
    expect(w.state.counter).toBe(5)
    expect(w.state.critical).toBe(true)
  })

  it('zero refresh followed by non-zero: counter resets to 0', () => {
    const w = makeProxyPoolWatchdog()
    w.refresh(0)
    w.refresh(0)
    w.refresh(25)
    expect(w.state.counter).toBe(0)
    expect(w.state.critical).toBe(false)
  })

  it('critical clears on first non-zero after streak', () => {
    const w = makeProxyPoolWatchdog()
    for (let i = 0; i < 5; i++) w.refresh(0)
    expect(w.state.critical).toBe(true)
    w.refresh(15)
    expect(w.state.critical).toBe(false)
    expect(w.state.counter).toBe(0)
  })

  it('partial recovery: 3 zeros, 1 non-zero, 1 zero — counter goes 3→0→1', () => {
    const w = makeProxyPoolWatchdog()
    w.refresh(0); w.refresh(0); w.refresh(0)
    expect(w.state.counter).toBe(3)
    w.refresh(15)
    expect(w.state.counter).toBe(0)
    w.refresh(0)
    expect(w.state.counter).toBe(1)
    expect(w.state.critical).toBe(false)
  })
})

describe('H2 — Watchdog properties (fast-check)', () => {
  it('counter only resets to 0 on non-zero (never to other value)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 5, maxLength: 50 }),
        (refreshes) => {
          const w = makeProxyPoolWatchdog()
          for (const r of refreshes) {
            const before = w.state.counter
            const after = w.refresh(r).counter
            if (r === 0 && after !== before + 1) return false
            if (r > 0  && after !== 0) return false
          }
          return true
        }
      ),
      { numRuns: 200 }
    )
  })

  it('critical iff counter≥3 (invariant)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 100 }),
        (refreshes) => {
          const w = makeProxyPoolWatchdog()
          for (const r of refreshes) {
            const s = w.refresh(r)
            if (s.critical !== (s.counter >= 3)) return false
          }
          return true
        }
      ),
      { numRuns: 200 }
    )
  })

  it('any single non-zero refresh recovers from critical state', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (recovery) => {
        const w = makeProxyPoolWatchdog()
        w.refresh(0); w.refresh(0); w.refresh(0); w.refresh(0); w.refresh(0)
        expect(w.state.critical).toBe(true)
        w.refresh(recovery)
        return w.state.critical === false
      }),
      { numRuns: 100 }
    )
  })

  it('counter monotonic during zero-streak (only increases)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const w = makeProxyPoolWatchdog()
        const counters = []
        for (let i = 0; i < n; i++) {
          w.refresh(0)
          counters.push(w.state.counter)
        }
        try {
          assertMonotonic(counters, 'increasing')
          return true
        } catch {
          return false
        }
      }),
      { numRuns: 100 }
    )
  })
})

describe('H2 — Anti-thrash protection', () => {
  it('alternating 0/1/0/1 sequence: critical never fires', () => {
    const w = makeProxyPoolWatchdog()
    for (let i = 0; i < 20; i++) {
      w.refresh(i % 2)
      if (w.state.critical) {
        throw new Error(`unexpected critical at iteration ${i}`)
      }
    }
    expect(w.state.critical).toBe(false)
  })

  it('counter never exceeds session length (bound check)', () => {
    const w = makeProxyPoolWatchdog()
    for (let i = 0; i < 100; i++) w.refresh(0)
    expect(w.state.counter).toBeLessThanOrEqual(100)
  })

  it('trace inspection: zero-streaks visible for incident reconstruction', () => {
    const w = makeProxyPoolWatchdog()
    w.refresh(0); w.refresh(0); w.refresh(0); w.refresh(15); w.refresh(0)
    const trace = w.trace
    expect(trace.length).toBe(5)
    expect(trace[2].critical).toBe(true)  // 3rd zero
    expect(trace[3].critical).toBe(false) // recovery
  })
})
