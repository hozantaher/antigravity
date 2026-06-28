import { describe, it, expect } from 'vitest'
import { clampInt } from '../../../src/lib/clampInt.js'

describe('clampInt', () => {
  it('returns the value when within bounds', () => {
    expect(clampInt(10, 1, 50)).toBe(10)
  })
  it('clamps to min when below', () => {
    expect(clampInt(0, 1, 50)).toBe(1)
    expect(clampInt(-5, 1, 50)).toBe(1)
  })
  it('clamps to max when above', () => {
    expect(clampInt(999, 1, 50)).toBe(50)
  })
  it('returns bound at the edges', () => {
    expect(clampInt(1, 1, 50)).toBe(1)
    expect(clampInt(50, 1, 50)).toBe(50)
  })
  it('matches the replaced Math.min(Math.max(...)) semantics for the migrated sites', () => {
    // mailboxes days default 7, [1,30]; limit default 20, [1,100]
    expect(clampInt(Number('') || 7, 1, 30)).toBe(7)
    expect(clampInt(Number('250') || 20, 1, 100)).toBe(100)
    // replies floor path
    expect(clampInt(Math.floor(12.9), 1, 1000)).toBe(12)
  })
})
