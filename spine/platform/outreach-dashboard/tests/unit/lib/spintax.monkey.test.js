// M1 — spintax monkey/adversarial tests.
// Hammers the lib with hostile input to verify:
//   - zero unhandled exceptions (only domain errors w/ clear msgs)
//   - return types stay consistent (string|number|array|object — never undefined)
//   - no prototype pollution (Object.prototype unchanged after 100+ inputs)
//   - memory bomb guard (100KB completes <500ms)
//
// Per memory feedback_extreme_testing.md: ≥30 cases for monkey suites.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  expandSpintax,
  countVariations,
  expandAllSpintax,
  validateSpintax,
} from '../../../src/lib/spintax.js'

// Helper: any thrown error must be a "domain" error — not a programming bug.
// Programming bugs = TypeError, RangeError, "Cannot read property of undefined".
function assertSafeCall(fn) {
  try {
    const result = fn()
    return { ok: true, result }
  } catch (e) {
    // Domain errors (Error, with a clear .message) are acceptable.
    // Programmer bugs (TypeError, RangeError) are NOT.
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(TypeError)
    expect(e).not.toBeInstanceOf(RangeError)
    expect(e).not.toBeInstanceOf(ReferenceError)
    expect(typeof e.message).toBe('string')
    expect(e.message.length).toBeGreaterThan(0)
    return { ok: false, error: e }
  }
}

describe('spintax monkey — adversarial inputs (M1)', () => {
  // ─────────────────────────────────────────────────────────────
  // Category 1: Control characters \x00-\x1f
  // ─────────────────────────────────────────────────────────────
  describe('control characters', () => {
    it('handles \\x00 null byte interleaved with spintax', () => {
      const inputs = [
        '\x00{a|b}\x00',
        '{a\x00|b\x00}',
        '\x00\x01\x02{x|y}\x03\x04',
        '{\x00|\x01|\x02}',
      ]
      for (const inp of inputs) {
        const r = assertSafeCall(() => expandSpintax(inp, 0))
        if (r.ok) expect(typeof r.result).toBe('string')
      }
    })

    it('handles all C0 controls \\x00-\\x1f mixed with braces', () => {
      let s = ''
      for (let i = 0; i < 32; i++) s += String.fromCharCode(i)
      const inp = `{${s}|alt}`
      const r = assertSafeCall(() => expandSpintax(inp, 1))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('countVariations does not crash on control chars', () => {
      const inp = '{\x00\x07\x1b|alt|\x0c\x1f}'
      const r = assertSafeCall(() => countVariations(inp))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('number')
      expect(r.result).toBeGreaterThanOrEqual(1)
    })

    it('validateSpintax does not crash on control chars', () => {
      const r = assertSafeCall(() => validateSpintax('\x00{a|b}\x1f'))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('object')
      expect(typeof r.result.ok).toBe('boolean')
      expect(Array.isArray(r.result.errors)).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 2: Very long inputs (100KB) — memory bomb guard
  // ─────────────────────────────────────────────────────────────
  describe('very long inputs', () => {
    it('handles 100KB plain text in <500ms', () => {
      const big = 'x'.repeat(100_000)
      const t0 = Date.now()
      const r = assertSafeCall(() => expandSpintax(big, 0))
      const dt = Date.now() - t0
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
      expect(dt).toBeLessThan(500)
    })

    it('handles 100KB with sparse braces', () => {
      const chunk = 'x'.repeat(1000)
      const inp = (chunk + '{a|b}').repeat(100) // ~100KB w/ 100 groups
      const t0 = Date.now()
      const r = assertSafeCall(() => expandSpintax(inp, 0))
      const dt = Date.now() - t0
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
      expect(dt).toBeLessThan(2000)
    })

    it('countVariations on 100KB input does not hang', () => {
      const inp = '{a|b}'.repeat(20_000) // count caps at VARIATION_CAP
      const t0 = Date.now()
      const r = assertSafeCall(() => countVariations(inp))
      const dt = Date.now() - t0
      expect(r.ok).toBe(true)
      expect(r.result === Infinity || typeof r.result === 'number').toBe(true)
      expect(dt).toBeLessThan(2000)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 3: Deep nesting (50 levels)
  // ─────────────────────────────────────────────────────────────
  describe('deep nesting', () => {
    it('handles 50-level nested groups', () => {
      let inp = 'x'
      for (let i = 0; i < 50; i++) inp = `{${inp}|y}`
      const t0 = Date.now()
      const r = assertSafeCall(() => expandSpintax(inp, 7))
      const dt = Date.now() - t0
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
      expect(dt).toBeLessThan(500)
    })

    it('handles 100-level nesting without stack overflow', () => {
      let inp = 'core'
      for (let i = 0; i < 100; i++) inp = `{${inp}|alt}`
      const r = assertSafeCall(() => expandSpintax(inp, 0))
      // RangeError (stack overflow) is forbidden — domain error or pass.
      // If it fails, error must NOT be RangeError (which assertSafeCall guards).
      if (r.ok) expect(typeof r.result).toBe('string')
    })

    it('countVariations on 50-level nesting clamps to Infinity or finite', () => {
      let inp = 'x'
      for (let i = 0; i < 50; i++) inp = `{${inp}|y}`
      const r = assertSafeCall(() => countVariations(inp))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('number')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 4: Unicode chaos
  // ─────────────────────────────────────────────────────────────
  describe('unicode chaos', () => {
    it('handles surrogate pair — emoji inside group', () => {
      // 🦀 = U+1F980 → surrogate pair D83E DD80
      const r = assertSafeCall(() => expandSpintax('{🦀|🚀|🎉}', 1))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
      expect(['🦀', '🚀', '🎉']).toContain(r.result)
    })

    it('handles RTL marks (U+200F) inside spintax', () => {
      const rtl = '‏'
      const r = assertSafeCall(() => expandSpintax(`{${rtl}a|${rtl}b}`, 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('handles zero-width joiner (U+200D)', () => {
      const zwj = '‍'
      const r = assertSafeCall(() => expandSpintax(`{x${zwj}y|alt}`, 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('handles combining diacritics (e + ́)', () => {
      const inp = '{é|è|ê}' // é è ê
      const r = assertSafeCall(() => expandSpintax(inp, 5))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('handles lone unpaired surrogate (malformed UTF-16)', () => {
      // \uD83E without paired low surrogate — JS string can hold this.
      const lone = '\uD83E'
      const r = assertSafeCall(() => expandSpintax(`{${lone}|ok}`, 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('handles BOM (U+FEFF) and bidi overrides', () => {
      const inp = '﻿{‮a‬|b}'
      const r = assertSafeCall(() => expandSpintax(inp, 1))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 5: Prototype pollution attempts
  // ─────────────────────────────────────────────────────────────
  describe('prototype pollution', () => {
    it('does not expose prototype keys via spintax', () => {
      const before = Object.keys(Object.prototype).slice()
      const adversarial = [
        '{__proto__|x}',
        '{constructor.prototype|y}',
        '{|}',
        '{__proto__|constructor|prototype}',
        '{toString|valueOf|hasOwnProperty}',
        '{__defineGetter__|__defineSetter__}',
      ]
      for (const inp of adversarial) {
        assertSafeCall(() => expandSpintax(inp, 0))
        assertSafeCall(() => countVariations(inp))
        assertSafeCall(() => expandAllSpintax(inp))
        assertSafeCall(() => validateSpintax(inp))
      }
      const after = Object.keys(Object.prototype).slice()
      expect(after).toEqual(before)
      // And: Object.prototype.x should NOT exist.
      expect(Object.prototype.x).toBeUndefined()
      expect(Object.prototype.polluted).toBeUndefined()
    })

    it('100 random adversarial inputs do not pollute Object.prototype', () => {
      const before = JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort())
      for (let i = 0; i < 100; i++) {
        const garbage = Math.random().toString(36) + '{__proto__|constructor|x}' + Math.random()
        assertSafeCall(() => expandSpintax(garbage, i))
      }
      const after = JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort())
      expect(after).toBe(before)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 6: Pathological seeds
  // ─────────────────────────────────────────────────────────────
  describe('pathological seeds', () => {
    it('NaN seed does not crash, returns string', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b|c}', NaN))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('Infinity seed does not crash', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b|c}', Infinity))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('-Infinity seed does not crash', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b|c}', -Infinity))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('very negative seed (-2^53) does not crash', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b|c}', -(2 ** 53)))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('-0 seed equals 0 seed, deterministic', () => {
      const a = assertSafeCall(() => expandSpintax('{a|b|c}', -0))
      const b = assertSafeCall(() => expandSpintax('{a|b|c}', 0))
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      expect(a.result).toBe(b.result)
    })

    it('seed 0 is a valid seed (not the same as undefined)', () => {
      // With seed=0 → mulberry32(0). With undefined → Math.random.
      // Determinism only required for explicit seeds.
      const a = assertSafeCall(() => expandSpintax('{a|b|c}', 0))
      const b = assertSafeCall(() => expandSpintax('{a|b|c}', 0))
      expect(a.ok && b.ok).toBe(true)
      expect(a.result).toBe(b.result)
    })

    it('Number.MAX_SAFE_INTEGER seed does not crash', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b|c}', Number.MAX_SAFE_INTEGER))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 7: Non-string inputs
  // ─────────────────────────────────────────────────────────────
  describe('non-string inputs', () => {
    it('array input does not crash', () => {
      const r = assertSafeCall(() => expandSpintax(['{a|b}'], 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('object input does not crash', () => {
      const r = assertSafeCall(() => expandSpintax({ toString: () => '{a|b}' }, 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('Symbol input does not crash', () => {
      const r = assertSafeCall(() => expandSpintax(Symbol('test'), 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('BigInt input does not crash', () => {
      const r = assertSafeCall(() => expandSpintax(123n, 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('function input does not crash', () => {
      const r = assertSafeCall(() => expandSpintax(() => 'lol', 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('Map input does not crash', () => {
      const r = assertSafeCall(() => expandSpintax(new Map([['a', 1]]), 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('Set input does not crash', () => {
      const r = assertSafeCall(() => expandSpintax(new Set(['a', 'b']), 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('null input → empty string', () => {
      const r = assertSafeCall(() => expandSpintax(null, 0))
      expect(r.ok).toBe(true)
      expect(r.result).toBe('')
    })

    it('undefined input → empty string', () => {
      const r = assertSafeCall(() => expandSpintax(undefined, 0))
      expect(r.ok).toBe(true)
      expect(r.result).toBe('')
    })

    it('countVariations on non-string returns 1', () => {
      expect(countVariations(null)).toBe(1)
      expect(countVariations(undefined)).toBe(1)
      expect(countVariations(123)).toBe(1)
      expect(countVariations({})).toBe(1)
      expect(countVariations([])).toBe(1)
    })

    it('expandAllSpintax on non-string returns [""]', () => {
      expect(expandAllSpintax(null)).toEqual([''])
      expect(expandAllSpintax(undefined)).toEqual([''])
      expect(expandAllSpintax(123)).toEqual([''])
    })

    it('validateSpintax on non-string returns ok:false', () => {
      const inputs = [null, undefined, 123, {}, [], Symbol('x'), 1n]
      for (const inp of inputs) {
        const r = assertSafeCall(() => validateSpintax(inp))
        expect(r.ok).toBe(true)
        expect(r.result.ok).toBe(false)
        expect(Array.isArray(r.result.errors)).toBe(true)
      }
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 8: Pathological backtracking patterns
  // ─────────────────────────────────────────────────────────────
  describe('pathological backtracking', () => {
    it('repeated nested {a|{a|{a|...}}} 30 levels does not hang', () => {
      let inp = 'a'
      for (let i = 0; i < 30; i++) inp = `{a|${inp}}`
      const t0 = Date.now()
      const r = assertSafeCall(() => expandSpintax(inp, 13))
      const dt = Date.now() - t0
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
      expect(dt).toBeLessThan(500)
    })

    it('expandAllSpintax on 20-level nest respects cap', () => {
      let inp = 'a'
      for (let i = 0; i < 20; i++) inp = `{a|${inp}}`
      const r = assertSafeCall(() => expandAllSpintax(inp, { cap: 50 }))
      expect(r.ok).toBe(true)
      expect(Array.isArray(r.result)).toBe(true)
      expect(r.result.length).toBeLessThanOrEqual(50)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 9: Pipe-only / brace-only / mixed brace garbage
  // ─────────────────────────────────────────────────────────────
  describe('brace and pipe edge cases', () => {
    it('pipe-only inputs do not crash', () => {
      const cases = ['|', '||', '|||', '|||||||']
      for (const inp of cases) {
        const r = assertSafeCall(() => expandSpintax(inp, 0))
        expect(r.ok).toBe(true)
        expect(typeof r.result).toBe('string')
        // No braces in input → output equals input.
        expect(r.result).toBe(inp)
      }
    })

    it('{|||} parses as group with empty branches', () => {
      const r = assertSafeCall(() => expandSpintax('{|||}', 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
      // All branches empty → result is empty string.
      expect(r.result).toBe('')
    })

    it('all-open braces "{{{{{{" do not hang', () => {
      const r = assertSafeCall(() => expandSpintax('{{{{{{', 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('all-close braces "}}}}}}" do not hang', () => {
      const r = assertSafeCall(() => expandSpintax('}}}}}}', 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('alternating "}{}{}{" does not hang', () => {
      const r = assertSafeCall(() => expandSpintax('}{}{}{}{}{', 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('"{{{{{}}}}}}}" (extra closes) does not hang', () => {
      const r = assertSafeCall(() => expandSpintax('{{{{{}}}}}}}', 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 10: Mixed escape attempts
  // ─────────────────────────────────────────────────────────────
  describe('escape attempts', () => {
    it('backslash-brace "\\{" treated as literal', () => {
      const r = assertSafeCall(() => expandSpintax('\\{a|b\\}', 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('many backslashes do not crash', () => {
      const r = assertSafeCall(() => expandSpintax('\\\\\\\\{a|b}', 0))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 11: 1000-iter fast-check fuzz
  // ─────────────────────────────────────────────────────────────
  describe('fast-check fuzz (1000 iterations)', () => {
    it('expandSpintax never throws unhandled on random strings (≤1KB)', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 1000 }), text => {
          const r = assertSafeCall(() => expandSpintax(text, 42))
          // Either ok or domain error — never a programming bug.
          if (r.ok) return typeof r.result === 'string'
          return r.error instanceof Error
        }),
        { numRuns: 1000 }
      )
    })

    it('countVariations never throws unhandled on random strings', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 500 }), text => {
          const r = assertSafeCall(() => countVariations(text))
          if (r.ok) return typeof r.result === 'number' && r.result >= 1
          return r.error instanceof Error
        }),
        { numRuns: 500 }
      )
    })

    it('validateSpintax never throws unhandled on random strings', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 500 }), text => {
          const r = assertSafeCall(() => validateSpintax(text))
          if (!r.ok) return r.error instanceof Error
          return (
            typeof r.result === 'object' &&
            typeof r.result.ok === 'boolean' &&
            Array.isArray(r.result.errors)
          )
        }),
        { numRuns: 500 }
      )
    })

    it('expandAllSpintax never throws unhandled on random strings (cap=64)', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 200 }), text => {
          const r = assertSafeCall(() => expandAllSpintax(text, { cap: 64 }))
          if (r.ok) return Array.isArray(r.result) && r.result.length <= 64
          return r.error instanceof Error
        }),
        { numRuns: 500 }
      )
    })

    it('1000 random JSON garbage as input → no crash', () => {
      // JSON-ish strings with weird escapes, nesting, quotes.
      const arbJsonish = fc.oneof(
        fc.string(),
        fc.json(),
        fc.string({ unit: 'binary' }),
        fc.stringMatching(/^[{}|\\]+$/),
      )
      fc.assert(
        fc.property(arbJsonish, text => {
          const r = assertSafeCall(() => expandSpintax(text, 0))
          if (r.ok) return typeof r.result === 'string'
          return r.error instanceof Error
        }),
        { numRuns: 1000 }
      )
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 12: BigInt / Symbol seed
  // ─────────────────────────────────────────────────────────────
  describe('non-numeric seeds', () => {
    it('BigInt seed (2n ** 60n) does not crash', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b}', 2n ** 60n))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('Symbol seed does not crash, falls back to default', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b}', Symbol('seed')))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('string seed "42" does not crash', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b|c}', '42'))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('null seed does not crash', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b|c}', null))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })

    it('object seed does not crash', () => {
      const r = assertSafeCall(() => expandSpintax('{a|b|c}', { x: 1 }))
      expect(r.ok).toBe(true)
      expect(typeof r.result).toBe('string')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 13: Memory bomb / size guard sanity
  // ─────────────────────────────────────────────────────────────
  describe('memory bomb guards', () => {
    it('100KB input completes <500ms', () => {
      const inp = '{a|b}' + 'x'.repeat(99_995)
      const t0 = Date.now()
      const r = assertSafeCall(() => expandSpintax(inp, 0))
      const dt = Date.now() - t0
      expect(r.ok).toBe(true)
      expect(dt).toBeLessThan(500)
    })

    it('expandAllSpintax cap guards combinatorial blowup', () => {
      // 2^15 = 32768 variants requested but cap=10
      const inp = '{a|b}'.repeat(15)
      const r = assertSafeCall(() => expandAllSpintax(inp, { cap: 10 }))
      expect(r.ok).toBe(true)
      expect(r.result.length).toBeLessThanOrEqual(10)
    })

    it('countVariations clamps to Infinity at VARIATION_CAP', () => {
      const inp = '{a|b}'.repeat(50) // 2^50
      expect(countVariations(inp)).toBe(Infinity)
    })

    it('1MB hard cap — input larger should still respond', () => {
      // 1MB of plain text — function should handle without OOM.
      const big = 'x'.repeat(1_000_000)
      const t0 = Date.now()
      const r = assertSafeCall(() => expandSpintax(big, 0))
      const dt = Date.now() - t0
      // Either succeeds quickly OR returns a domain error.
      // Must NOT hang or crash.
      expect(dt).toBeLessThan(3000)
      if (r.ok) expect(typeof r.result).toBe('string')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Category 14: Return type consistency
  // ─────────────────────────────────────────────────────────────
  describe('return types are never undefined', () => {
    const weirdInputs = [
      '',
      '{',
      '}',
      '|',
      '{|}',
      '{a}',
      '{{}}',
      '{a|b|}',
      '{|a|b}',
      null,
      undefined,
      0,
      NaN,
      [],
      {},
    ]

    it('expandSpintax always returns a string', () => {
      for (const inp of weirdInputs) {
        const r = expandSpintax(inp, 0)
        expect(typeof r).toBe('string')
      }
    })

    it('countVariations always returns a number ≥ 1', () => {
      for (const inp of weirdInputs) {
        const r = countVariations(inp)
        expect(typeof r).toBe('number')
        expect(r).toBeGreaterThanOrEqual(1)
      }
    })

    it('expandAllSpintax always returns an array', () => {
      for (const inp of weirdInputs) {
        const r = expandAllSpintax(inp)
        expect(Array.isArray(r)).toBe(true)
        expect(r.length).toBeGreaterThanOrEqual(1)
      }
    })

    it('validateSpintax always returns { ok, errors[] }', () => {
      for (const inp of weirdInputs) {
        const r = validateSpintax(inp)
        expect(typeof r).toBe('object')
        expect(r).not.toBeNull()
        expect(typeof r.ok).toBe('boolean')
        expect(Array.isArray(r.errors)).toBe(true)
      }
    })
  })
})
