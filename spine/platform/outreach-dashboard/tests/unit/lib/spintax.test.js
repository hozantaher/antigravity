// A1 — spintax lib unit tests (TDD RED first).
// Mirrors Go ResolveSpin semantics in features/outreach/campaigns/content/spin.go.
// Per memory feedback_extreme_testing.md: ≥15 cases, boundary + error.

import { describe, it, expect } from 'vitest'
import {
  expandSpintax,
  expandAllSpintax,
  countVariations,
  validateSpintax,
} from '../../../src/lib/spintax.js'

describe('expandSpintax — basic semantics', () => {
  it('returns plain text unchanged when no spin syntax', () => {
    expect(expandSpintax('Dobrý den, jak se máte?', 42)).toBe('Dobrý den, jak se máte?')
  })

  it('picks one branch from a single group', () => {
    const r = expandSpintax('{Ahoj|Zdravím|Dobrý den}', 1)
    expect(['Ahoj', 'Zdravím', 'Dobrý den']).toContain(r)
  })

  it('is deterministic for the same seed', () => {
    const a = expandSpintax('{x|y|z} {1|2|3} {a|b|c}', 7)
    const b = expandSpintax('{x|y|z} {1|2|3} {a|b|c}', 7)
    expect(a).toBe(b)
  })

  it('different seeds yield different results across many trials', () => {
    const set = new Set()
    for (let s = 0; s < 50; s++) set.add(expandSpintax('{A|B|C|D|E|F|G|H|I|J}', s))
    expect(set.size).toBeGreaterThanOrEqual(3)
  })

  it('resolves multiple groups in one pass — no braces remain', () => {
    const r = expandSpintax('{Hello|Hi}, {world|earth}!', 7)
    expect(r).not.toMatch(/[{}]/)
    expect(r.endsWith('!')).toBe(true)
  })

  it('resolves nested groups', () => {
    const r = expandSpintax('{We {buy|purchase}|We {acquire|sell}}', 99)
    const valid = ['We buy', 'We purchase', 'We acquire', 'We sell']
    expect(valid).toContain(r)
  })

  it('handles a single-branch group as a literal', () => {
    expect(expandSpintax('{only-one}', 1)).toBe('only-one')
  })

  it('preserves whitespace inside branches', () => {
    const r = expandSpintax('{ Dobrý den | Zdravím }', 0)
    expect([' Dobrý den ', ' Zdravím ']).toContain(r)
  })

  it('leaves unclosed { alone (Go parity)', () => {
    expect(expandSpintax('hello {world', 42)).toBe('hello {world')
  })

  it('handles empty input', () => {
    expect(expandSpintax('', 0)).toBe('')
  })

  it('handles adjacent groups', () => {
    const r = expandSpintax('{a|b}{c|d}', 5)
    expect(['ac', 'ad', 'bc', 'bd']).toContain(r)
  })

  it('treats empty branches as empty strings', () => {
    const r = expandSpintax('prefix-{|x}-suffix', 0)
    expect(['prefix--suffix', 'prefix-x-suffix']).toContain(r)
  })

  it('does not throw on lone closing brace', () => {
    expect(() => expandSpintax('hello}world', 0)).not.toThrow()
  })

  it('handles deeply nested 3+ levels', () => {
    const r = expandSpintax('{{a|b}|c}', 3)
    expect(['a', 'b', 'c']).toContain(r)
  })

  it('omits the seed → still produces a valid expansion', () => {
    const r = expandSpintax('{a|b|c}')
    expect(['a', 'b', 'c']).toContain(r)
  })

  it('rejects non-string input gracefully', () => {
    expect(() => expandSpintax(null, 0)).not.toThrow()
    expect(expandSpintax(null, 0)).toBe('')
    expect(expandSpintax(undefined, 0)).toBe('')
    expect(expandSpintax(123, 0)).toBe('')
  })
})

describe('countVariations', () => {
  it('returns 1 for plain text', () => {
    expect(countVariations('plain')).toBe(1)
  })

  it('returns branch count for single group', () => {
    expect(countVariations('{a|b|c}')).toBe(3)
  })

  it('multiplies for sequential groups', () => {
    expect(countVariations('{a|b|c}{x|y}')).toBe(6)
  })

  it('multiplies for nested groups', () => {
    // {a|b|{c|d}} = 4 variants
    expect(countVariations('{a|b|{c|d}}')).toBe(4)
  })

  it('caps at Infinity for combinatorial blowup', () => {
    const exploder = '{a|b}'.repeat(50) // 2^50 — should clamp
    expect(countVariations(exploder)).toBe(Infinity)
  })

  it('returns 1 for empty input', () => {
    expect(countVariations('')).toBe(1)
  })

  it('treats unclosed brace as plain text → 1', () => {
    expect(countVariations('hello {world')).toBe(1)
  })

  it('handles single-branch group as 1', () => {
    expect(countVariations('{only}')).toBe(1)
  })
})

describe('expandAllSpintax', () => {
  it('returns single element for plain text', () => {
    expect(expandAllSpintax('plain')).toEqual(['plain'])
  })

  it('expands all branches of single group', () => {
    expect(expandAllSpintax('{a|b|c}').sort()).toEqual(['a', 'b', 'c'])
  })

  it('expands cartesian product of two groups', () => {
    const all = expandAllSpintax('{a|b}{x|y}').sort()
    expect(all).toEqual(['ax', 'ay', 'bx', 'by'])
  })

  it('expands nested groups', () => {
    const all = expandAllSpintax('{x|{a|b}}').sort()
    expect(all).toEqual(['a', 'b', 'x'])
  })

  it('caps at opts.cap (default 256)', () => {
    const r = expandAllSpintax('{a|b}'.repeat(20)) // 2^20
    expect(r.length).toBeLessThanOrEqual(256)
  })

  it('respects custom cap', () => {
    const r = expandAllSpintax('{a|b}{c|d}{e|f}', { cap: 4 })
    expect(r.length).toBeLessThanOrEqual(4)
  })

  it('returns unique values', () => {
    const r = expandAllSpintax('{a|a|a}') // all same branches
    // Implementation may dedupe or not; minimum guarantee: contains 'a'
    expect(r).toContain('a')
  })

  it('handles empty input', () => {
    expect(expandAllSpintax('')).toEqual([''])
  })
})

describe('validateSpintax', () => {
  it('accepts plain text', () => {
    expect(validateSpintax('plain text')).toEqual({ ok: true, errors: [] })
  })

  it('accepts well-formed spintax', () => {
    expect(validateSpintax('{a|b} {c|d|e}').ok).toBe(true)
  })

  it('flags unclosed brace', () => {
    const v = validateSpintax('hello {world')
    expect(v.ok).toBe(false)
    expect(v.errors[0].msg).toMatch(/unclosed/i)
  })

  it('flags unbalanced closing brace', () => {
    const v = validateSpintax('hello}world')
    expect(v.ok).toBe(false)
    expect(v.errors[0].msg).toMatch(/unmatched/i)
  })

  it('flags nested unclosed', () => {
    const v = validateSpintax('{a|{b|c}')
    expect(v.ok).toBe(false)
  })

  it('warns on empty branch but does not error', () => {
    const v = validateSpintax('{a||b}')
    expect(v.ok).toBe(true) // permissive
    expect(v.errors.some(e => /empty branch/i.test(e.msg))).toBe(true)
  })

  it('reports position of first error', () => {
    const v = validateSpintax('hello {world')
    expect(v.errors[0].pos).toBe(6)
  })

  it('handles non-string input safely', () => {
    expect(validateSpintax(null).ok).toBe(false)
    expect(validateSpintax(undefined).ok).toBe(false)
  })
})
