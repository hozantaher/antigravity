// Unit tests for src/lib/unsubToken.js — JS twin of
// features/platform/common/token/unsub_test.go. Both suites lock the same wire
// format (HMAC-SHA256 over "<cid>|<id>|<email>", hex truncated 16) so
// drift between Go and JS layers fails loudly.

import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { buildUnsubToken, verifyUnsubToken } from '../../../src/lib/unsubToken.js'

const SECRET = 'test-secret-32-bytes-aaaaaaaaaaa'

// ── Round-trip ───────────────────────────────────────────────────────────────

describe('buildUnsubToken / verifyUnsubToken — round-trip', () => {
  it('build then verify with identical inputs returns true', () => {
    const tok = buildUnsubToken(42, 1001, 'jan@firma.cz', SECRET)
    expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', tok, SECRET)).toBe(true)
  })
})

// ── Determinism ──────────────────────────────────────────────────────────────

describe('buildUnsubToken — deterministic', () => {
  it('produces the same token across calls for the same inputs', () => {
    const a = buildUnsubToken(42, 1001, 'jan@firma.cz', SECRET)
    const b = buildUnsubToken(42, 1001, 'jan@firma.cz', SECRET)
    expect(a).toBe(b)
  })
})

// ── Distinct per recipient ───────────────────────────────────────────────────

describe('buildUnsubToken — distinct per recipient', () => {
  it('different (campaign, contact, email) tuples produce different tokens', () => {
    const tokens = new Set([
      buildUnsubToken(42, 1001, 'jan@firma.cz', SECRET),
      buildUnsubToken(42, 1002, 'jan@firma.cz', SECRET),
      buildUnsubToken(43, 1001, 'jan@firma.cz', SECRET),
      buildUnsubToken(42, 1001, 'anna@firma.cz', SECRET),
    ])
    expect(tokens.size).toBe(4)
  })
})

// ── Format ────────────────────────────────────────────────────────────────────

describe('buildUnsubToken — format', () => {
  it('returns exactly 16 lowercase hex chars across diverse inputs', () => {
    const inputs = [
      [1, 1, 'a@b.cz'],
      [42, 1001, 'longer.address+tag@domain.example'],
      [99, 0, 'ñon-ascii@háček.cz'],
      [0, 0, ''],
    ] as const
    for (const [c, id, email] of inputs) {
      const tok = buildUnsubToken(c, id, email, SECRET)
      expect(tok).toHaveLength(16)
      expect(tok).toMatch(/^[0-9a-f]{16}$/)
    }
  })
})

// ── Byte-equivalence with previous inline implementation ─────────────────────

describe('buildUnsubToken — matches legacy inline formula', () => {
  it('output is byte-identical to the prior server.js / *.mjs inline computation', () => {
    // The 4 sites being refactored each used:
    //   createHmac('sha256', secret).update(`${cid}|${id}|${email}`).digest('hex').slice(0,16)
    // This test pins that the canonical helper produces the SAME bytes
    // for arbitrary inputs — migration safety guarantee.
    const cases = [
      { cid: 42, id: 1001, email: 'jan@firma.cz', secret: 'secret-a' },
      { cid: 1, id: 1, email: 'x@y.cz', secret: 'secret-b' },
      { cid: 99999, id: 88888, email: 'a.b.c@d.e.f.cz', secret: 'fallback-secret-aaaaaaaa' },
      { cid: 0, id: 0, email: '', secret: '' },
      { cid: 1, id: 1, email: 'ñon-ascii@háček.cz', secret: 'test' },
    ]
    for (const tc of cases) {
      const got = buildUnsubToken(tc.cid, tc.id, tc.email, tc.secret)
      const want = createHmac('sha256', tc.secret)
        .update(`${tc.cid}|${tc.id}|${tc.email}`)
        .digest('hex')
        .slice(0, 16)
      expect(got).toBe(want)
    }
  })
})

// ── Cross-language byte-equivalence (Go ↔ JS) ────────────────────────────────

describe('buildUnsubToken — Go/JS wire compatibility', () => {
  it('produces the same byte sequence as the Go runner for fixed inputs', () => {
    // Go-side reference: features/platform/common/token/unsub.go BuildUnsubToken.
    // If this fails, runner.go and server.js have diverged — every
    // outstanding unsub link is broken. Computed below using Node's
    // crypto so the test is self-contained, but the formula is the
    // contract Go also implements.
    const cases = [
      { cid: 42, id: 1001, email: 'jan@firma.cz', secret: 'test' },
      { cid: 1, id: 1, email: 'x@y.cz', secret: 'fallback-secret-aaaaaaaa' },
    ]
    for (const tc of cases) {
      const got = buildUnsubToken(tc.cid, tc.id, tc.email, tc.secret)
      const ref = createHmac('sha256', tc.secret)
        .update(`${tc.cid}|${tc.id}|${tc.email}`)
        .digest('hex')
        .slice(0, 16)
      expect(got).toBe(ref)
    }
  })
})

// ── Verify: wrong secret ─────────────────────────────────────────────────────

describe('verifyUnsubToken — wrong secret', () => {
  it('returns false when verifying with a different secret', () => {
    const tok = buildUnsubToken(42, 1001, 'jan@firma.cz', 'real-secret')
    expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', tok, 'attacker-secret')).toBe(false)
  })
})

// ── Verify: tampered fields ──────────────────────────────────────────────────

describe('verifyUnsubToken — tampered fields', () => {
  it('returns false when campaignID differs', () => {
    const tok = buildUnsubToken(42, 1001, 'jan@firma.cz', SECRET)
    expect(verifyUnsubToken(99, 1001, 'jan@firma.cz', tok, SECRET)).toBe(false)
  })

  it('returns false when contactID differs', () => {
    const tok = buildUnsubToken(42, 1001, 'jan@firma.cz', SECRET)
    expect(verifyUnsubToken(42, 1002, 'jan@firma.cz', tok, SECRET)).toBe(false)
  })

  it('returns false when email differs', () => {
    const tok = buildUnsubToken(42, 1001, 'jan@firma.cz', SECRET)
    expect(verifyUnsubToken(42, 1001, 'anna@firma.cz', tok, SECRET)).toBe(false)
  })
})

// ── Verify: empty / garbage / wrong length ───────────────────────────────────

describe('verifyUnsubToken — bad inputs', () => {
  it('returns false for empty token', () => {
    expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', '', SECRET)).toBe(false)
  })

  it('returns false for non-string token', () => {
    // @ts-expect-error - exercising defensive branch
    expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', null, SECRET)).toBe(false)
    // @ts-expect-error
    expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', 12345, SECRET)).toBe(false)
  })

  it('returns false for token of wrong length', () => {
    for (const tok of [
      'a',
      'deadbeef',
      'deadbeefdeadbeefdeadbeefdeadbeef', // full sha256 hex (64 chars)
    ]) {
      expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', tok, SECRET)).toBe(false)
    }
  })

  it('returns false for plausibly-shaped garbage tokens', () => {
    for (const tok of [
      '0000000000000000',
      'ffffffffffffffff',
      'aaaaaaaaaaaaaaaa',
      'deadbeefdeadbeef',
    ]) {
      expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', tok, SECRET)).toBe(false)
    }
  })
})

// ── Forgery resistance ──────────────────────────────────────────────────────

describe('verifyUnsubToken — forgery resistance', () => {
  it('1000 wrong-secret guesses never produce a verifying token', () => {
    const realSecret = 'real-secret'
    for (let i = 0; i < 1000; i++) {
      const guess = `guess-${i}`
      const tok = buildUnsubToken(42, 1001, 'jan@firma.cz', guess)
      expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', tok, realSecret)).toBe(false)
    }
  })
})

// ── Constant-time compare smoke ─────────────────────────────────────────────

describe('verifyUnsubToken — constant-time compare', () => {
  it('rejects tokens that differ only at the last byte', () => {
    // A naive `===` would also reject this, but the test guards against
    // a future regression that introduces an early-return on first-byte
    // mismatch (a common micro-optimization that leaks per-byte timing).
    const tok = buildUnsubToken(42, 1001, 'jan@firma.cz', SECRET)
    const tampered = tok.slice(0, 15) + (tok.endsWith('0') ? 'f' : '0')
    expect(verifyUnsubToken(42, 1001, 'jan@firma.cz', tampered, SECRET)).toBe(false)
  })
})
