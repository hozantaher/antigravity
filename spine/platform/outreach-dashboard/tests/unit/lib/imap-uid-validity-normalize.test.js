import { describe, it, expect } from 'vitest'

/**
 * P0 incident 2026-05-14: runImapPollCron emitted false "UIDVALIDITY
 * changed (1 → 1)" log lines on every poll because the pg driver returns
 * bigint columns as strings ("1") while the relay returns JSON number
 * (1), and the strict !== comparison treated them as different.
 *
 * This test pins the behaviour: the normalised comparison must return
 * the same verdict regardless of whether either side comes back as
 * a string, a number, or a BigInt.
 */

const normalizeUidValidity = (v) => {
  if (v == null) return null
  try { return BigInt(v) } catch { return null }
}

const validityChanged = (prev, curr) => {
  const a = normalizeUidValidity(prev)
  const b = normalizeUidValidity(curr)
  return a != null && b != null && a !== b
}

describe('runImapPollCron UIDVALIDITY change detection (incident 2026-05-14)', () => {
  it('string "1" vs number 1 — same value, not changed (incident smoking gun)', () => {
    expect(validityChanged('1', 1)).toBe(false)
  })

  it('number 1 vs string "1" — symmetric', () => {
    expect(validityChanged(1, '1')).toBe(false)
  })

  it('string vs string — same value, not changed', () => {
    expect(validityChanged('1', '1')).toBe(false)
  })

  it('number vs number — same value, not changed', () => {
    expect(validityChanged(1, 1)).toBe(false)
  })

  it('genuine change: 1 → 2 (number)', () => {
    expect(validityChanged(1, 2)).toBe(true)
  })

  it('genuine change: "1" → "2" (string)', () => {
    expect(validityChanged('1', '2')).toBe(true)
  })

  it('genuine change: "1" → 2 (mixed types, still changed)', () => {
    expect(validityChanged('1', 2)).toBe(true)
  })

  it('genuine change: 1 → "2" (mixed types, still changed)', () => {
    expect(validityChanged(1, '2')).toBe(true)
  })

  it('null prev — no signal, not changed', () => {
    expect(validityChanged(null, 1)).toBe(false)
  })

  it('null curr — no signal, not changed', () => {
    expect(validityChanged(1, null)).toBe(false)
  })

  it('both null — not changed', () => {
    expect(validityChanged(null, null)).toBe(false)
  })

  it('large bigint-range values match without precision loss', () => {
    // pg bigint can exceed Number.MAX_SAFE_INTEGER; BigInt normalisation
    // preserves the full value.
    const big = '9007199254740993' // 2^53 + 1
    expect(validityChanged(big, big)).toBe(false)
  })

  it('large bigint vs bigint+1 — genuine change preserved at 64-bit width', () => {
    expect(validityChanged('9007199254740993', '9007199254740994')).toBe(true)
  })

  it('non-numeric junk safely returns null → not changed', () => {
    expect(validityChanged('not-a-number', 1)).toBe(false)
  })

  it('zero vs "0" — same, not changed', () => {
    expect(validityChanged(0, '0')).toBe(false)
  })
})
