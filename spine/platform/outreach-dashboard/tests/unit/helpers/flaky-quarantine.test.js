// H7 — Flaky-test auto-quarantine logic tests.

import { describe, it, expect } from 'vitest'
import {
  shouldQuarantine,
  shouldRestore,
  recordRun,
  emptyHistory,
  rollingFailureRate,
} from '../../helpers/flaky-quarantine.js'

describe('rollingFailureRate', () => {
  it('returns 0 for empty history', () => {
    expect(rollingFailureRate([])).toBe(0)
  })

  it('returns 1 when all fails', () => {
    expect(rollingFailureRate([{ ok: false }, { ok: false }])).toBe(1)
  })

  it('returns 0.3 for 3/10 fails', () => {
    const h = Array.from({ length: 10 }, (_, i) => ({ ok: i >= 3 }))
    expect(rollingFailureRate(h)).toBeCloseTo(0.3, 5)
  })

  it('respects custom window', () => {
    const h = [{ ok: false }, { ok: false }, { ok: true }, { ok: true }, { ok: true }]
    // last 3 = 3 OKs → rate 0
    expect(rollingFailureRate(h, 3)).toBe(0)
  })
})

describe('shouldQuarantine', () => {
  it('false when fewer than threshold runs', () => {
    expect(shouldQuarantine([{ ok: false }, { ok: false }])).toBe(false)
  })

  it('true when 3+ fails out of last 10 runs', () => {
    const h = [
      { ok: true }, { ok: true }, { ok: true },
      { ok: false }, { ok: true }, { ok: false },
      { ok: true }, { ok: true }, { ok: false }, { ok: true },
    ]
    expect(shouldQuarantine(h)).toBe(true)
  })

  it('false when 2 fails out of 10', () => {
    const h = Array.from({ length: 10 }, (_, i) => ({ ok: i >= 2 }))
    expect(shouldQuarantine(h)).toBe(false)
  })

  it('respects custom threshold', () => {
    const h = Array.from({ length: 10 }, (_, i) => ({ ok: i >= 1 }))
    expect(shouldQuarantine(h, { threshold: 1 })).toBe(true)
    expect(shouldQuarantine(h, { threshold: 2 })).toBe(false)
  })

  it('only considers last N runs (rolling window)', () => {
    // 5 fails in old runs, then 10 passes in last window
    const h = [
      ...Array.from({ length: 5 }, () => ({ ok: false })),
      ...Array.from({ length: 10 }, () => ({ ok: true })),
    ]
    expect(shouldQuarantine(h, { window: 10 })).toBe(false)
  })
})

describe('shouldRestore', () => {
  it('true after 3+ consecutive passes on quarantined test', () => {
    const h = [
      { ok: false }, { ok: false }, { ok: false },
      { ok: true }, { ok: true }, { ok: true },
    ]
    expect(shouldRestore(h, { quarantined: true })).toBe(true)
  })

  it('false when last run was a fail', () => {
    const h = [
      { ok: true }, { ok: true }, { ok: true }, { ok: false },
    ]
    expect(shouldRestore(h, { quarantined: true })).toBe(false)
  })

  it('false when not quarantined', () => {
    const h = [{ ok: true }, { ok: true }, { ok: true }]
    expect(shouldRestore(h, { quarantined: false })).toBe(false)
  })

  it('respects custom consecutivePasses threshold', () => {
    const h = [{ ok: true }, { ok: true }]
    expect(shouldRestore(h, { quarantined: true, consecutivePasses: 2 })).toBe(true)
    expect(shouldRestore(h, { quarantined: true, consecutivePasses: 3 })).toBe(false)
  })
})

describe('recordRun + emptyHistory', () => {
  it('emptyHistory returns valid empty structure', () => {
    expect(emptyHistory()).toEqual({ runs: [] })
  })

  it('recordRun appends to history', () => {
    const h = recordRun(emptyHistory(), { ok: true, duration_ms: 100, at: '2026-04-26' })
    expect(h.runs.length).toBe(1)
    expect(h.runs[0].ok).toBe(true)
  })

  it('recordRun caps history at maxRuns (default 100)', () => {
    let h = emptyHistory()
    for (let i = 0; i < 150; i++) h = recordRun(h, { ok: i % 2 === 0 })
    expect(h.runs.length).toBe(100)
  })

  it('recordRun preserves chronological order (newest last)', () => {
    let h = emptyHistory()
    h = recordRun(h, { ok: true, at: '2026-04-26T01:00:00Z' })
    h = recordRun(h, { ok: false, at: '2026-04-26T02:00:00Z' })
    expect(h.runs[h.runs.length - 1].ok).toBe(false)
  })

  it('rejects malformed run record', () => {
    expect(() => recordRun(emptyHistory(), { invalid: true })).toThrow(/ok/i)
  })
})

describe('Quarantine state machine — full lifecycle', () => {
  it('healthy → quarantined → restored cycle', () => {
    let h = emptyHistory()
    let isQ = false

    // 7 passes
    for (let i = 0; i < 7; i++) h = recordRun(h, { ok: true })
    expect(shouldQuarantine(h.runs)).toBe(false)

    // 3 fails — over threshold (3/10)
    for (let i = 0; i < 3; i++) h = recordRun(h, { ok: false })
    expect(shouldQuarantine(h.runs)).toBe(true)
    isQ = true

    // 3 consecutive passes restore
    for (let i = 0; i < 3; i++) h = recordRun(h, { ok: true })
    expect(shouldRestore(h.runs, { quarantined: isQ })).toBe(true)
  })

  it('flaky never restored if alternating', () => {
    let h = emptyHistory()
    for (let i = 0; i < 20; i++) h = recordRun(h, { ok: i % 2 === 0 })
    expect(shouldQuarantine(h.runs)).toBe(true)
    expect(shouldRestore(h.runs, { quarantined: true })).toBe(false)
  })
})
