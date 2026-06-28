import { describe, it, expect } from 'vitest'
import { buildUnsubToken, verifyUnsubToken } from '../../../src/lib/unsubToken.js'

const SECRET = 'test-unsub-secret'

describe('buildUnsubToken — HMAC token derivation', () => {
  it('returns exactly 16 lowercase hex chars', () => {
    const t = buildUnsubToken(42, 7, 'a@b.cz', SECRET)
    expect(t).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic for identical inputs', () => {
    const a = buildUnsubToken(42, 7, 'a@b.cz', SECRET)
    const b = buildUnsubToken(42, 7, 'a@b.cz', SECRET)
    expect(a).toBe(b)
  })

  it('changes when any binding field changes', () => {
    const base = buildUnsubToken(42, 7, 'a@b.cz', SECRET)
    expect(buildUnsubToken(43, 7, 'a@b.cz', SECRET)).not.toBe(base)
    expect(buildUnsubToken(42, 8, 'a@b.cz', SECRET)).not.toBe(base)
    expect(buildUnsubToken(42, 7, 'c@d.cz', SECRET)).not.toBe(base)
    expect(buildUnsubToken(42, 7, 'a@b.cz', 'other-secret')).not.toBe(base)
  })

  it('treats numeric and string ids identically (template coercion)', () => {
    expect(buildUnsubToken(42, 7, 'a@b.cz', SECRET)).toBe(
      buildUnsubToken('42', '7', 'a@b.cz', SECRET)
    )
  })

  it('email case is part of the binding (no normalization)', () => {
    expect(buildUnsubToken(1, 1, 'A@B.CZ', SECRET)).not.toBe(
      buildUnsubToken(1, 1, 'a@b.cz', SECRET)
    )
  })

  it('handles unicode / diacritics in email-local part', () => {
    const t = buildUnsubToken(1, 1, 'jiří@firma.cz', SECRET)
    expect(t).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('verifyUnsubToken — constant-time verification', () => {
  it('accepts a correctly-built token', () => {
    const t = buildUnsubToken(42, 7, 'a@b.cz', SECRET)
    expect(verifyUnsubToken(42, 7, 'a@b.cz', t, SECRET)).toBe(true)
  })

  it('rejects a token built for different fields', () => {
    const t = buildUnsubToken(42, 7, 'a@b.cz', SECRET)
    expect(verifyUnsubToken(99, 7, 'a@b.cz', t, SECRET)).toBe(false)
  })

  it('rejects a token built with a different secret', () => {
    const t = buildUnsubToken(42, 7, 'a@b.cz', 'wrong')
    expect(verifyUnsubToken(42, 7, 'a@b.cz', t, SECRET)).toBe(false)
  })

  it('rejects empty string, non-string, and length-mismatched input', () => {
    expect(verifyUnsubToken(42, 7, 'a@b.cz', '', SECRET)).toBe(false)
    expect(verifyUnsubToken(42, 7, 'a@b.cz', null, SECRET)).toBe(false)
    expect(verifyUnsubToken(42, 7, 'a@b.cz', undefined, SECRET)).toBe(false)
    expect(verifyUnsubToken(42, 7, 'a@b.cz', 'deadbeef', SECRET)).toBe(false) // 8 chars
    expect(verifyUnsubToken(42, 7, 'a@b.cz', 12345, SECRET)).toBe(false)
  })

  it('rejects a one-nibble-tampered 16-char token (no short-circuit accept)', () => {
    const t = buildUnsubToken(42, 7, 'a@b.cz', SECRET)
    const flipped = (t[0] === '0' ? '1' : '0') + t.slice(1)
    expect(flipped).toHaveLength(16)
    expect(verifyUnsubToken(42, 7, 'a@b.cz', flipped, SECRET)).toBe(false)
  })
})
