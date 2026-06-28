import { describe, it, expect } from 'vitest'
import {
  isPlaceholderPassword,
  hasRepeatedTrigram,
  KNOWN_BAD_PREFIXES,
  MIN_REAL_PASSWORD_LEN,
} from '../../../src/lib/passwordValidator.js'

// ── isPlaceholderPassword ────────────────────────────────────────────────────

describe('isPlaceholderPassword via has_valid_password', () => {
  // ── Happy path: real passwords are NOT placeholders ──────────────────────

  it('real password → valid (not placeholder)', () => {
    expect(isPlaceholderPassword('Tr0mb0n3!')).toBe(false)
  })

  it('123p123p123p123p123 → VALID (user real password, no repeated trigrams ≥7)', () => {
    // "123" appears 4 times — below the threshold of 7. Should be valid.
    expect(isPlaceholderPassword('123p123p123p123p123')).toBe(false)
  })

  it('long diverse password → valid', () => {
    expect(isPlaceholderPassword('!K7mL#vQ9xR')).toBe(false)
  })

  it('exactly MIN_REAL_PASSWORD_LEN chars, no bad prefix → valid', () => {
    // 8 chars, no known prefix
    expect(isPlaceholderPassword('abcd1234')).toBe(false)
  })

  // ── Empty / missing ───────────────────────────────────────────────────────

  it('empty string → placeholder (invalid)', () => {
    expect(isPlaceholderPassword('')).toBe(true)
  })

  it('null → placeholder (invalid)', () => {
    expect(isPlaceholderPassword(null)).toBe(true)
  })

  it('undefined → placeholder (invalid)', () => {
    expect(isPlaceholderPassword(undefined)).toBe(true)
  })

  // ── Wrong type ────────────────────────────────────────────────────────────

  it('number 12345678 → placeholder (not a string)', () => {
    expect(isPlaceholderPassword(12345678)).toBe(true)
  })

  it('object → placeholder (not a string)', () => {
    expect(isPlaceholderPassword({ password: 'realpass' })).toBe(true)
  })

  // ── Too short ─────────────────────────────────────────────────────────────

  it('7-char string (< MIN_REAL_PASSWORD_LEN) → placeholder', () => {
    expect(isPlaceholderPassword('abcdefg')).toBe(true)
  })

  it('1-char string → placeholder', () => {
    expect(isPlaceholderPassword('x')).toBe(true)
  })

  // ── Known bad prefixes (case-insensitive) ─────────────────────────────────

  it('"heslo" prefix → placeholder', () => {
    expect(isPlaceholderPassword('heslo12345')).toBe(true)
  })

  it('"HESLO" uppercase prefix → placeholder', () => {
    expect(isPlaceholderPassword('HESLO12345')).toBe(true)
  })

  it('"change-me" prefix → placeholder', () => {
    expect(isPlaceholderPassword('change-me-now')).toBe(true)
  })

  it('"admin" prefix → placeholder', () => {
    expect(isPlaceholderPassword('admin1234')).toBe(true)
  })

  it('"ADMIN" uppercase prefix → placeholder', () => {
    expect(isPlaceholderPassword('ADMIN1234')).toBe(true)
  })

  it('"xxxx" prefix → placeholder', () => {
    expect(isPlaceholderPassword('xxxx-secret')).toBe(true)
  })

  it('"password" prefix → placeholder', () => {
    expect(isPlaceholderPassword('password123')).toBe(true)
  })

  it('"Password" mixed-case prefix → placeholder', () => {
    expect(isPlaceholderPassword('Password123')).toBe(true)
  })

  it('"test" prefix → placeholder', () => {
    expect(isPlaceholderPassword('testpass1')).toBe(true)
  })

  // ── Repeated trigram detection ────────────────────────────────────────────

  it('7+ repeated trigrams → placeholder', () => {
    // "abc" repeating 8 times — well above the threshold of 7
    expect(isPlaceholderPassword('abcabcabcabcabcabcabcabc')).toBe(true)
  })

  it('exactly 7 repeats of same trigram → placeholder', () => {
    // "aaa" × 7 = 21 chars, "aaa" appears 19 times in sliding window
    expect(isPlaceholderPassword('aaaaaaaaaaaaaaaaaaaaa')).toBe(true)
  })

  it('6 repeats of trigram (below threshold) + diverse → NOT placeholder', () => {
    // "ab" repeated 6 times still below, padded to reach 8+ chars
    const p = 'ababababXY'
    // 'aba' appears 4 times, 'bab' appears 4 times — both below 7
    expect(isPlaceholderPassword(p)).toBe(false)
  })

  // ── MONKEY: 20 diverse inputs — never throws ──────────────────────────────

  it('MONKEY: 20 diverse inputs → never throws, always returns boolean', () => {
    const inputs = [
      null, undefined, '', 0, false, true, [], {}, Symbol('x'),
      'a', 'abcdefgh', 'short', 'x'.repeat(100),
      'HESLO123', 'password!', 'Admin1234',
      '!#$%^&*()', 'válid-password-8', NaN, Infinity,
    ]
    for (const inp of inputs) {
      let result
      expect(() => { result = isPlaceholderPassword(inp) }).not.toThrow()
      expect(typeof result).toBe('boolean')
    }
  })
})

// ── hasRepeatedTrigram ────────────────────────────────────────────────────────

describe('hasRepeatedTrigram', () => {
  it('string shorter than 3*minRepeats → false', () => {
    expect(hasRepeatedTrigram('ab', 3)).toBe(false)
  })

  it('no repeated trigram → false', () => {
    expect(hasRepeatedTrigram('abcdefghij', 3)).toBe(false)
  })

  it('trigram repeated ≥ minRepeats → true', () => {
    expect(hasRepeatedTrigram('abcabcabc', 3)).toBe(true)
  })

  it('non-string → false', () => {
    expect(hasRepeatedTrigram(null, 3)).toBe(false)
    expect(hasRepeatedTrigram(undefined, 3)).toBe(false)
    expect(hasRepeatedTrigram(42, 3)).toBe(false)
  })
})

// ── KNOWN_BAD_PREFIXES coverage ───────────────────────────────────────────────

describe('KNOWN_BAD_PREFIXES — all prefixes are covered', () => {
  for (const prefix of KNOWN_BAD_PREFIXES) {
    it(`prefix "${prefix}" triggers placeholder detection`, () => {
      // Pad to at least MIN_REAL_PASSWORD_LEN to rule out the length check
      const p = prefix + 'X'.repeat(Math.max(0, MIN_REAL_PASSWORD_LEN - prefix.length))
      expect(isPlaceholderPassword(p)).toBe(true)
    })
  }
})
