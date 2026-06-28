/**
 * AR-Wave3 (2026-05-18) — Unit tests for the Czech relative + absolute
 * time formatters (ticket #5). Each branch of formatRelative is covered
 * with a fixed `now` clock so the assertions are deterministic across
 * timezones + CI machines.
 *
 * Branch matrix:
 *   1. < 60 s         → "právě teď"
 *   2. < 60 min       → "X min"
 *   3. same day       → "dnes HH:MM"
 *   4. yesterday      → "včera HH:MM"
 *   5. < 7 days       → "<cs weekday> HH:MM"
 *   6. < 365 days     → "DD. M."
 *   7. >= 1 year      → "DD. M. YYYY"
 *   8. invalid input  → "—" (relative) + "" (absolute)
 */
import { describe, it, expect } from 'vitest'
import { formatRelative, formatAbsolute } from '../../../src/lib/replyTime.js'

// Fixed clock for deterministic branch tests. 2026-05-18 17:00:00 local.
function fixedNow(year, monthZeroBased, day, hour, min) {
  return new Date(year, monthZeroBased, day, hour, min, 0).getTime()
}

describe('formatRelative (AR-Wave3 ticket #5)', () => {
  const NOW = fixedNow(2026, 4 /* May */, 18, 17, 0)

  it('< 60 s → "právě teď"', () => {
    const at = new Date(NOW - 30_000).toISOString()
    expect(formatRelative(at, NOW)).toBe('právě teď')
  })

  it('< 60 min → "X min"', () => {
    const at = new Date(NOW - 5 * 60_000).toISOString()
    expect(formatRelative(at, NOW)).toBe('5 min')
  })

  it('same local day, >1h → "dnes HH:MM"', () => {
    // 14:35 local on 2026-05-18 → "dnes 14:35"
    const at = new Date(2026, 4, 18, 14, 35, 0).toISOString()
    expect(formatRelative(at, NOW)).toBe('dnes 14:35')
  })

  it('yesterday → "včera HH:MM"', () => {
    // 09:12 local on 2026-05-17 → "včera 09:12"
    const at = new Date(2026, 4, 17, 9, 12, 0).toISOString()
    expect(formatRelative(at, NOW)).toBe('včera 09:12')
  })

  it('< 7 days (not today / not yesterday) → "<cs weekday> HH:MM"', () => {
    // 2026-05-14 14:36 local — that's Thursday → "Čt 14:36"
    const at = new Date(2026, 4, 14, 14, 36, 0).toISOString()
    expect(formatRelative(at, NOW)).toBe('Čt 14:36')
  })

  it('< 365 days → "DD. M."', () => {
    // 2026-02-03 → 104 days before, < 365 → "3. 2."
    const at = new Date(2026, 1, 3, 12, 0, 0).toISOString()
    expect(formatRelative(at, NOW)).toBe('3. 2.')
  })

  it('>= 1 year → "DD. M. YYYY"', () => {
    // 2024-12-31 → > 1 year → "31. 12. 2024"
    const at = new Date(2024, 11, 31, 18, 0, 0).toISOString()
    expect(formatRelative(at, NOW)).toBe('31. 12. 2024')
  })

  it('null / undefined / invalid → "—"', () => {
    expect(formatRelative(null, NOW)).toBe('—')
    expect(formatRelative(undefined, NOW)).toBe('—')
    expect(formatRelative('not-a-date', NOW)).toBe('—')
  })
})

describe('formatAbsolute (AR-Wave3 ticket #5)', () => {
  it('formats valid timestamp as "D. M. YYYY HH:MM"', () => {
    const at = new Date(2026, 4, 18, 17, 35, 0).toISOString()
    expect(formatAbsolute(at)).toBe('18. 5. 2026 17:35')
  })

  it('pads single-digit hour/minute to two characters', () => {
    const at = new Date(2026, 4, 18, 9, 5, 0).toISOString()
    expect(formatAbsolute(at)).toBe('18. 5. 2026 09:05')
  })

  it('null / undefined / invalid → empty string (safe for title=)', () => {
    expect(formatAbsolute(null)).toBe('')
    expect(formatAbsolute(undefined)).toBe('')
    expect(formatAbsolute('not-a-date')).toBe('')
  })
})
