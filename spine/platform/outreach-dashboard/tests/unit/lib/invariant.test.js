// Tests for src/lib/invariant.js — Phase 7 Sprint I1.
//
// Covers ≥15 cases:
//   - happy path no-op
//   - logs without throw flag
//   - throws when INVARIANT_THROW=1
//   - sample rate boundaries (0% / 100% / 0.5)
//   - boot suite summary, fatal escalation, warn-only
//   - Sentry breadcrumb shape
//   - guardTransition allow / deny
//   - property: short-circuit on truthy condition
//   - concurrent calls
//   - defensive: undefined condition, non-string message

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Sentry mock -------------------------------------------------------------
// Both @sentry/node and @sentry/react are tried inside emitBreadcrumb. We
// mock @sentry/node since it loads first in the BFF environment.
const breadcrumbs = []
vi.mock('@sentry/node', () => ({
  addBreadcrumb: (b) => {
    breadcrumbs.push(b)
  },
}))
// @sentry/react is fallback only — leave it unmocked so the import fails-or-noop.

// Import AFTER mocks
const { invariant, runBootInvariants, guardTransition, InvariantViolation } =
  await import('../../../src/lib/invariant.js')

// --- helpers ----------------------------------------------------------------
const ORIGINAL_ENV = { ...process.env }

function resetEnv() {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.INVARIANT_THROW
  delete process.env.INVARIANT_SAMPLE_RATE
  // jsdom test env has NODE_ENV=test by default; leave it as non-prod
  process.env.NODE_ENV = 'test'
}

let warnSpy
beforeEach(() => {
  resetEnv()
  breadcrumbs.length = 0
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  vi.restoreAllMocks()
  process.env = { ...ORIGINAL_ENV }
})

// --- 1. invariant happy path -------------------------------------------------
describe('invariant() — happy path', () => {
  it('truthy condition is a no-op (no log, no breadcrumb, no throw)', () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = '1'
    expect(() => invariant(true, 'should not fire')).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(breadcrumbs).toHaveLength(0)
  })

  it('truthy short-circuit even with expensive ctx (does not evaluate fail path)', () => {
    let touched = false
    const expensiveCtx = {
      get expensive() {
        touched = true
        return 'value'
      },
    }
    invariant(1 + 1 === 2, 'math holds', expensiveCtx)
    // Property: condition truthy → invariant must not even attempt to log
    // (which would JSON.stringify ctx). `touched` stays false.
    expect(touched).toBe(false)
  })
})

// --- 2. invariant failure path ----------------------------------------------
describe('invariant() — failure (no throw flag)', () => {
  it('non-prod default: logs AND throws (NODE_ENV=test default)', () => {
    process.env.NODE_ENV = 'test'
    expect(() => invariant(false, 'boom', { ctx: 'x' })).toThrow(InvariantViolation)
    expect(warnSpy).toHaveBeenCalled()
    const line = warnSpy.mock.calls[0][0]
    expect(line).toContain('[invariant]')
    expect(line).toContain('boom')
  })

  it('prod + INVARIANT_THROW unset: logs but does NOT throw', () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = '1' // force log
    let threw = false
    try {
      invariant(false, 'silent in prod')
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('prod + INVARIANT_THROW=1: throws even in prod', () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_THROW = '1'
    process.env.INVARIANT_SAMPLE_RATE = '1'
    expect(() => invariant(false, 'fatal')).toThrow(InvariantViolation)
  })

  it('thrown InvariantViolation carries ctx', () => {
    process.env.NODE_ENV = 'test'
    try {
      invariant(false, 'boom', { campaign: 42 })
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantViolation)
      expect(e.ctx).toEqual({ campaign: 42 })
      expect(e.name).toBe('InvariantViolation')
      return
    }
    throw new Error('expected throw')
  })
})

// --- 3. sample rate ---------------------------------------------------------
describe('invariant() — sample rate', () => {
  it('rate=0 in prod → never logs', () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = '0'
    for (let i = 0; i < 200; i++) invariant(false, 'never logs')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('rate=1 in prod → always logs', () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = '1'
    for (let i = 0; i < 50; i++) invariant(false, 'always logs')
    expect(warnSpy).toHaveBeenCalledTimes(50)
  })

  it('rate=0.5 in prod → ~50% over 1000 calls (chi-square sanity)', () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = '0.5'
    const N = 1000
    for (let i = 0; i < N; i++) invariant(false, 'half')
    const observed = warnSpy.mock.calls.length
    // Expected = 500. Allow ±100 (very generous; binomial 99.99%CI ≈ ±63).
    expect(observed).toBeGreaterThan(400)
    expect(observed).toBeLessThan(600)
  })

  it('non-prod always 100% regardless of INVARIANT_SAMPLE_RATE', () => {
    process.env.NODE_ENV = 'development'
    process.env.INVARIANT_SAMPLE_RATE = '0'
    process.env.INVARIANT_THROW = '0' // suppress throw to count cleanly
    // We need throw off in dev, so manually unset NODE_ENV check by using prod
    // — but the spec says non-prod = 100%. Use development:
    for (let i = 0; i < 20; i++) {
      try { invariant(false, 'dev') } catch { /* throws because dev */ }
    }
    expect(warnSpy.mock.calls.length).toBe(20)
  })

  it('invalid INVARIANT_SAMPLE_RATE falls back to 1% (default)', () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = 'not-a-number'
    // 1000 calls @ 1% → expect ~10 logs. Allow [0, 40].
    for (let i = 0; i < 1000; i++) invariant(false, 'fallback')
    const n = warnSpy.mock.calls.length
    expect(n).toBeGreaterThanOrEqual(0)
    expect(n).toBeLessThan(40)
  })
})

// --- 4. boot invariant suite ------------------------------------------------
describe('runBootInvariants()', () => {
  it('3 pass + 1 warn + 1 fatal-pass → counts correct', async () => {
    // Avoid the fatal-fail path (it throws); use only passes + warnings.
    const summary = await runBootInvariants([
      { name: 'a', fn: async () => true, severity: 'fatal' },
      { name: 'b', fn: async () => true, severity: 'warn' },
      { name: 'c', fn: async () => true, severity: 'fatal' },
      { name: 'd', fn: async () => false, severity: 'warn' },
      { name: 'e', fn: async () => true, severity: 'warn' },
    ])
    expect(summary.passed).toBe(4)
    expect(summary.failed).toBe(0)
    expect(summary.warnings).toBe(1)
    expect(summary.results).toHaveLength(5)
    expect(summary.results.find((r) => r.name === 'd').ok).toBe(false)
  })

  it('fatal failure throws InvariantViolation (overrides INVARIANT_THROW=0)', async () => {
    process.env.INVARIANT_THROW = '0'
    process.env.NODE_ENV = 'production'
    await expect(
      runBootInvariants([
        { name: 'db', fn: async () => false, severity: 'fatal' },
      ]),
    ).rejects.toThrow(InvariantViolation)
  })

  it('warn-only failure does NOT throw, just records', async () => {
    process.env.NODE_ENV = 'production'
    const summary = await runBootInvariants([
      { name: 'go-backend', fn: async () => false, severity: 'warn' },
    ])
    expect(summary.warnings).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it('rejects malformed checks list', async () => {
    await expect(runBootInvariants(null)).rejects.toThrow(InvariantViolation)
    await expect(runBootInvariants([{ name: 'x' }])).rejects.toThrow()
  })

  it('async fn that rejects → counts as failure with error message', async () => {
    const summary = await runBootInvariants([
      {
        name: 'flaky',
        fn: async () => {
          throw new Error('oops')
        },
        severity: 'warn',
      },
    ])
    expect(summary.warnings).toBe(1)
    expect(summary.results[0].error).toBe('oops')
  })
})

// --- 5. Sentry breadcrumb shape --------------------------------------------
describe('Sentry breadcrumb', () => {
  it('breadcrumb shape: { category: "invariant", message, data }', async () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = '1'
    process.env.INVARIANT_THROW = '0'

    invariant(false, 'shape-check', { run: 7 })
    // emitBreadcrumb is fire-and-forget async — yield once.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(breadcrumbs.length).toBeGreaterThanOrEqual(1)
    const b = breadcrumbs[0]
    expect(b.category).toBe('invariant')
    expect(b.message).toBe('shape-check')
    expect(b.level).toBe('warning')
    expect(b.data).toEqual({ ctx: { run: 7 } })
  })

  it('breadcrumb data is empty object when ctx omitted', async () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = '1'
    process.env.INVARIANT_THROW = '0'
    invariant(false, 'no-ctx')
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(breadcrumbs.at(-1).data).toEqual({})
  })
})

// --- 6. guardTransition -----------------------------------------------------
describe('guardTransition()', () => {
  const machine = {
    canTransition(from, to) {
      // mailbox lifecycle: active ↔ paused, paused → needs_human, terminal=disabled
      const allowed = new Set([
        'active→paused',
        'paused→active',
        'paused→needs_human',
        'active→needs_human',
      ])
      return allowed.has(`${from}→${to}`)
    },
  }

  it('allowed transition returns true', () => {
    expect(guardTransition(machine, 'active', 'paused')).toBe(true)
    expect(guardTransition(machine, 'paused', 'needs_human')).toBe(true)
  })

  it('denied transition throws InvariantViolation with ctx', () => {
    try {
      guardTransition(machine, 'disabled', 'active')
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantViolation)
      expect(e.message).toMatch(/forbidden transition/)
      expect(e.ctx).toEqual({ from: 'disabled', to: 'active' })
      return
    }
    throw new Error('expected throw')
  })

  it('missing canTransition throws', () => {
    expect(() => guardTransition({}, 'a', 'b')).toThrow(InvariantViolation)
    expect(() => guardTransition(null, 'a', 'b')).toThrow(InvariantViolation)
  })

  it('canTransition that throws is wrapped in InvariantViolation', () => {
    const broken = {
      canTransition() {
        throw new Error('inner')
      },
    }
    try {
      guardTransition(broken, 'a', 'b')
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantViolation)
      expect(e.ctx.error).toBe('inner')
      return
    }
    throw new Error('expected throw')
  })
})

// --- 7. defensive ----------------------------------------------------------
describe('defensive coercion', () => {
  it('undefined condition is treated as failure', () => {
    process.env.NODE_ENV = 'test'
    expect(() => invariant(undefined, 'undef')).toThrow(InvariantViolation)
  })

  it('null condition is treated as failure', () => {
    process.env.NODE_ENV = 'test'
    expect(() => invariant(null, 'null')).toThrow(InvariantViolation)
  })

  it('non-string message is coerced', () => {
    process.env.NODE_ENV = 'test'
    try {
      invariant(false, 12345)
    } catch (e) {
      expect(e.message).toBe('12345')
      return
    }
    throw new Error('expected throw')
  })

  it('null message becomes "invariant violation"', () => {
    process.env.NODE_ENV = 'test'
    try {
      invariant(false, null)
    } catch (e) {
      expect(e.message).toBe('invariant violation')
      return
    }
    throw new Error('expected throw')
  })

  it('object message stringified', () => {
    process.env.NODE_ENV = 'test'
    const m = { toString: () => 'custom-stringified' }
    try {
      invariant(false, m)
    } catch (e) {
      expect(e.message).toBe('custom-stringified')
      return
    }
    throw new Error('expected throw')
  })
})

// --- 8. concurrency / thread-safety ----------------------------------------
describe('concurrent invariant() calls', () => {
  it('100 concurrent failures are all logged independently (no shared state corruption)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.INVARIANT_SAMPLE_RATE = '1'
    process.env.INVARIANT_THROW = '0'

    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        Promise.resolve().then(() => invariant(false, `n=${i}`)),
      ),
    )

    expect(warnSpy.mock.calls.length).toBe(100)
    const messages = warnSpy.mock.calls.map((c) => c[0])
    // All distinct
    expect(new Set(messages).size).toBe(100)
  })
})
