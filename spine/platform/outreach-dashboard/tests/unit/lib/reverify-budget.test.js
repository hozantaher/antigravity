// BF-A5 — runEmailReverifyCron rate-limit decision tests.
// Pure-fn computeReverifyBudget governs how many rows the cron picks
// per run, given accumulated daily count + stale-row count.

import { describe, it, expect } from 'vitest'
import { computeReverifyBudget } from '../../../src/lib/automation.js'

describe('computeReverifyBudget — happy path', () => {
  it('plenty of stale, no daily progress → defaultBatch (200)', () => {
    const r = computeReverifyBudget({ stale: 5000 })
    expect(r.batch).toBe(200)
    expect(r.reason).toMatch(/200/)
  })

  it('stale exactly defaultBatch → batch matches stale', () => {
    const r = computeReverifyBudget({ stale: 200 })
    expect(r.batch).toBe(200)
  })

  it('stale below defaultBatch → batch = stale', () => {
    const r = computeReverifyBudget({ stale: 73 })
    expect(r.batch).toBe(73)
  })
})

describe('computeReverifyBudget — daily cap', () => {
  it('alreadyToday=999, dailyMax=1000 → 1 remaining (capped)', () => {
    const r = computeReverifyBudget({ stale: 5000, alreadyToday: 999 })
    expect(r.batch).toBe(1)
  })

  it('alreadyToday=1000 → 0 (cap hit)', () => {
    const r = computeReverifyBudget({ stale: 5000, alreadyToday: 1000 })
    expect(r.batch).toBe(0)
    expect(r.reason).toMatch(/daily cap/)
  })

  it('alreadyToday>dailyMax (clock skew, manual run) → 0', () => {
    const r = computeReverifyBudget({ stale: 5000, alreadyToday: 1500 })
    expect(r.batch).toBe(0)
  })

  it('custom dailyMax honored', () => {
    const r = computeReverifyBudget(
      { stale: 5000, alreadyToday: 50 },
      { dailyMax: 100 }
    )
    expect(r.batch).toBe(50) // remaining=50
  })

  it('custom defaultBatch honored', () => {
    const r = computeReverifyBudget(
      { stale: 5000 },
      { defaultBatch: 50 }
    )
    expect(r.batch).toBe(50)
  })
})

describe('computeReverifyBudget — empty / defensive inputs', () => {
  it('stale=0 → 0', () => {
    const r = computeReverifyBudget({ stale: 0 })
    expect(r.batch).toBe(0)
    expect(r.reason).toMatch(/no stale/)
  })

  it('stale=null → 0', () => {
    const r = computeReverifyBudget({ stale: null })
    expect(r.batch).toBe(0)
  })

  it('stale=undefined → 0', () => {
    const r = computeReverifyBudget({})
    expect(r.batch).toBe(0)
  })

  it('alreadyToday null → treated as 0', () => {
    const r = computeReverifyBudget({ stale: 100, alreadyToday: null })
    expect(r.batch).toBe(100)
  })

  it('stale as string (PG count::int → JSON int but defensively coerce)', () => {
    const r = computeReverifyBudget({ stale: '5000' })
    expect(r.batch).toBe(200)
  })

  it('alreadyToday as string', () => {
    const r = computeReverifyBudget({ stale: 5000, alreadyToday: '999' })
    expect(r.batch).toBe(1)
  })
})

describe('computeReverifyBudget — interaction', () => {
  it('default budget < remaining < stale → defaultBatch wins', () => {
    // remaining = 1000 - 200 = 800; defaultBatch = 200; stale = 1000
    const r = computeReverifyBudget({ stale: 1000, alreadyToday: 200 })
    expect(r.batch).toBe(200) // min(200, 800, 1000)
  })

  it('remaining < defaultBatch < stale → remaining wins', () => {
    // remaining = 1000 - 950 = 50; defaultBatch = 200; stale = 5000
    const r = computeReverifyBudget({ stale: 5000, alreadyToday: 950 })
    expect(r.batch).toBe(50) // min(200, 50, 5000)
  })

  it('stale < remaining < defaultBatch → stale wins', () => {
    // remaining = 1000 - 0 = 1000; defaultBatch = 200; stale = 30
    const r = computeReverifyBudget({ stale: 30 })
    expect(r.batch).toBe(30) // min(200, 1000, 30)
  })
})
