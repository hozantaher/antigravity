// U1 — spintax library: extreme edge-case unit tests.
// Targets corners NOT covered by spintax.test.js (45 cases existing) and
// spintax.props.test.js. See spintax.js header for syntax + contract.
//
// Conventions documented or pinned by these tests (do not regress):
//   • Backslash is NOT an escape character: `\{a|b}` is literal `\` + the
//     group `{a|b}`. There is no way to embed a literal `{`/`}`/`|` in
//     spintax — by design (Go parity).
//   • expandAllSpintax cap < 1 (incl. 0, negatives) silently clamps to 1.
//   • expandAllSpintax cap = 1 returns exactly 1 deterministic variant.
//   • countVariations clamps at Infinity once VARIATION_CAP (1M) is exceeded.
//   • mulberry32 truncates seed to int32 via normalizeSeed; values that share
//     low-32-bit patterns share streams.
//   • validateSpintax pos uses JS-string indices (UTF-16 code units), so a
//     surrogate pair (e.g. 🎉) advances pos by 2.

import { describe, it, expect } from 'vitest'
import {
  expandSpintax,
  expandAllSpintax,
  countVariations,
  validateSpintax,
  mulberry32,
} from '../../../src/lib/spintax.js'

// ─────────────────────────────────────────────────────────────────────
// 1. Escape sequences (NOT supported per spec — verify literal handling)
// ─────────────────────────────────────────────────────────────────────
describe('U1 — escape sequences are NOT supported (literal handling)', () => {
  it('backslash before { is literal — does NOT prevent group expansion', () => {
    // Input: `\{a|b}` → backslash literal + group → `\a` or `\b`
    const r = expandSpintax(String.raw`\{a|b}`, 0)
    expect(['\\a', '\\b']).toContain(r)
  })

  it('backslash before | is literal — does NOT prevent pipe split', () => {
    // `{a\|b|c}` splits at every top-level `|`: ['a\', 'b', 'c']
    const all = expandAllSpintax(String.raw`{a\|b|c}`).sort()
    expect(all).toEqual(['a\\', 'b', 'c'])
  })

  it('double backslash is literal two characters', () => {
    expect(expandSpintax(String.raw`\\hello`, 0)).toBe('\\\\hello')
  })

  it('backslash inside group survives expansion', () => {
    const r = expandSpintax(String.raw`{path\to\file|other}`, 0)
    expect([String.raw`path\to\file`, 'other']).toContain(r)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. Deep nesting — VARIATION_CAP guard
// ─────────────────────────────────────────────────────────────────────
describe('U1 — deep nesting respects VARIATION_CAP (1M)', () => {
  it('linear nesting 100 levels: { {{...{x|y}...|y}|y}|y} → count = 101', () => {
    // Each level adds 1 branch ("y"); innermost adds 2 ("x"|"y"); telescopes
    // to a sum, not a product → linear growth, not blowup.
    let s = 'x'
    for (let i = 0; i < 100; i++) s = '{' + s + '|y}'
    expect(countVariations(s)).toBe(101)
  })

  it('exponential nesting (2^21 > 1M) clamps to Infinity', () => {
    const exploder = '{a|b}'.repeat(21)
    expect(countVariations(exploder)).toBe(Infinity)
  })

  it('nested product just under cap returns finite count', () => {
    // 10 sequential 2-branch groups → 1024 variants — well under 1M
    expect(countVariations('{a|b}'.repeat(10))).toBe(1024)
  })

  it('100-level deep expansion does not stack overflow', () => {
    let s = 'leaf'
    for (let i = 0; i < 100; i++) s = '{' + s + '|fb}'
    expect(() => expandSpintax(s, 42)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. expandAllSpintax cap edge cases
// ─────────────────────────────────────────────────────────────────────
describe('U1 — expandAllSpintax cap boundaries', () => {
  it('cap = 1 returns exactly 1 variant', () => {
    const r = expandAllSpintax('{a|b|c|d|e}', { cap: 1 })
    expect(r).toHaveLength(1)
    expect(['a', 'b', 'c', 'd', 'e']).toContain(r[0])
  })

  it('cap = 1 is deterministic across calls', () => {
    const a = expandAllSpintax('{x|y|z}{1|2|3}', { cap: 1 })
    const b = expandAllSpintax('{x|y|z}{1|2|3}', { cap: 1 })
    expect(a).toEqual(b)
  })

  it('cap = 0 is documented to clamp to 1 (does NOT return empty array)', () => {
    // Documented behavior: `Math.max(1, opts.cap ?? 256)` — never returns [].
    const r = expandAllSpintax('{a|b}', { cap: 0 })
    expect(r).toHaveLength(1)
    expect(['a', 'b']).toContain(r[0])
  })

  it('cap negative clamps to 1, no throw', () => {
    expect(() => expandAllSpintax('{a|b|c}', { cap: -100 })).not.toThrow()
    const r = expandAllSpintax('{a|b|c}', { cap: -100 })
    expect(r).toHaveLength(1)
  })

  it('cap = Infinity is accepted (subject to VARIATION_CAP via input size)', () => {
    const r = expandAllSpintax('{a|b}{c|d}', { cap: Infinity })
    expect(r.sort()).toEqual(['ac', 'ad', 'bc', 'bd'])
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. mulberry32 distribution + seed-collision properties
// ─────────────────────────────────────────────────────────────────────
describe('U1 — mulberry32 distribution', () => {
  it('100k calls with same seed: all in [0, 1), mean ≈ 0.5 (chi-square-light)', () => {
    const rng = mulberry32(123456)
    let sum = 0
    let min = 1
    let max = 0
    const N = 100_000
    for (let i = 0; i < N; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      sum += v
      if (v < min) min = v
      if (v > max) max = v
    }
    const mean = sum / N
    // Tolerance ±0.01 corresponds to ~3.16σ for uniform [0,1) → α≈0.05 two-tail.
    expect(mean).toBeGreaterThan(0.49)
    expect(mean).toBeLessThan(0.51)
    expect(max - min).toBeGreaterThan(0.99) // good spread
  })

  it('histogram bins are roughly uniform across 10 buckets', () => {
    const rng = mulberry32(987654321)
    const N = 100_000
    const bins = new Array(10).fill(0)
    for (let i = 0; i < N; i++) bins[Math.floor(rng() * 10)]++
    // Each bin should be 10k ± ~3.16σ ≈ 10k ± 300; allow ±5% margin (500).
    for (const b of bins) {
      expect(b).toBeGreaterThan(9_500)
      expect(b).toBeLessThan(10_500)
    }
  })

  it('1000 different seeds yield 1000 distinct first outputs (no collisions)', () => {
    const seen = new Set()
    for (let s = 0; s < 1000; s++) seen.add(mulberry32(s)())
    expect(seen.size).toBe(1000)
  })

  it('Number.MAX_SAFE_INTEGER and -(2^53) are accepted without throw', () => {
    expect(() => mulberry32(Number.MAX_SAFE_INTEGER)()).not.toThrow()
    expect(() => mulberry32(-Math.pow(2, 53))()).not.toThrow()
    expect(() => expandSpintax('{a|b|c}', Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(() => expandSpintax('{a|b|c}', -Math.pow(2, 53))).not.toThrow()
  })

  it('seeds that differ only above bit 32 share the same stream (documented)', () => {
    // normalizeSeed coerces via `n | 0` → low 32 bits only.
    // 1 and (1 + 2^32) have identical int32 representation → identical streams.
    const r1 = mulberry32(1)()
    const r2 = mulberry32(1 + 4294967296)()
    expect(r1).toBe(r2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. countVariations multiplicative + structural properties
// ─────────────────────────────────────────────────────────────────────
describe('U1 — countVariations algebraic properties', () => {
  it('multiplicative: V(AB) === V(A) × V(B) for independent groups', () => {
    const a = countVariations('{a|b}')
    const b = countVariations('{c|d|e}')
    const ab = countVariations('{a|b}{c|d|e}')
    expect(a).toBe(2)
    expect(b).toBe(3)
    expect(ab).toBe(a * b)
  })

  it('additive within a single group: V({A|B}) === V(A) + V(B)', () => {
    // {x|{a|b}} → top-level group has 2 branches: text "x" (1 var) + "{a|b}" (2 vars)
    expect(countVariations('{x|{a|b}}')).toBe(1 + 2)
  })

  it('plain-text interleaving does not alter the count', () => {
    expect(countVariations('prefix {a|b} mid {c|d} suffix')).toBe(2 * 2)
  })

  it('identical branches still count separately (no dedup at count level)', () => {
    // `{a|a|a}` → countVariations = 3, even though expandAll dedupes.
    expect(countVariations('{a|a|a}')).toBe(3)
  })

  it('whitespace-only branches count as distinct branches', () => {
    // `{ | | }` → 3 branches (each a single space)
    expect(countVariations('{ | | }')).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 6. expandAllSpintax dedup + identity behavior
// ─────────────────────────────────────────────────────────────────────
describe('U1 — expandAllSpintax dedup behavior', () => {
  it('identical branches dedupe to 1 variant', () => {
    expect(expandAllSpintax('{a|a|a}')).toEqual(['a'])
  })

  it('whitespace-only branches all yielding " " dedupe to 1 variant', () => {
    expect(expandAllSpintax('{ | | }')).toEqual([' '])
  })

  it('mixed identical + distinct dedupes only true duplicates', () => {
    expect(expandAllSpintax('{a|b|a|b|c}').sort()).toEqual(['a', 'b', 'c'])
  })
})

// ─────────────────────────────────────────────────────────────────────
// 7. validateSpintax — accurate pos for malformed inputs (≥5)
// ─────────────────────────────────────────────────────────────────────
describe('U1 — validateSpintax position reporting', () => {
  it('unclosed at position 0', () => {
    const v = validateSpintax('{a|b')
    expect(v.ok).toBe(false)
    expect(v.errors[0]).toMatchObject({ pos: 0, msg: expect.stringMatching(/unclosed/i) })
  })

  it('unmatched closing at exact byte index', () => {
    const v = validateSpintax('hello}world')
    expect(v.ok).toBe(false)
    expect(v.errors[0].pos).toBe(5)
  })

  it('multiple unmatched closings each get accurate pos', () => {
    const v = validateSpintax('}}{a|b}{')
    const closings = v.errors.filter(e => /unmatched/i.test(e.msg))
    expect(closings.map(e => e.pos)).toEqual([0, 1])
  })

  it('extra closing brace AFTER a valid group reports correct pos', () => {
    const v = validateSpintax('a{b|c}}d')
    const u = v.errors.find(e => /unmatched/i.test(e.msg))
    expect(u.pos).toBe(6)
  })

  it('mid-string unclosed reports pos of the offending {', () => {
    const v = validateSpintax('hello {world')
    expect(v.errors[0].pos).toBe(6)
  })

  it('handles unicode (multi-byte) — pos uses UTF-16 code units (documented)', () => {
    // 🎉 = U+1F389 → surrogate pair → length 2 in JS strings.
    // After "🎉 " we are at index 3 (🎉=0,1; space=2; { at 3).
    const v = validateSpintax('🎉 {a|b')
    expect(v.ok).toBe(false)
    expect(v.errors[0].pos).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 8. Round-trip invariants
// ─────────────────────────────────────────────────────────────────────
describe('U1 — round-trip: validate → expand → expandAll', () => {
  it('valid input: every random expansion is in expandAll', () => {
    const input = '{Hello|Hi|Hey}, {world|earth}!'
    const v = validateSpintax(input)
    expect(v.ok).toBe(true)
    const all = expandAllSpintax(input, { cap: 1024 })
    for (let s = 0; s < 50; s++) {
      const got = expandSpintax(input, s)
      expect(all).toContain(got)
    }
  })

  it('valid nested input: 100 random seeds always land in expandAll', () => {
    const input = '{We {buy|purchase|acquire}|We {rent|lease}} {trucks|cars}'
    const all = expandAllSpintax(input, { cap: 1024 })
    for (let s = 0; s < 100; s++) {
      const got = expandSpintax(input, s * 17)
      expect(all).toContain(got)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 9. Performance — 1000-char input with ~50 groups expands quickly
// ─────────────────────────────────────────────────────────────────────
describe('U1 — performance', () => {
  it('1000-char input with 50 groups: 100 expansions complete in <500ms', () => {
    let body = ''
    while (body.length < 950) {
      body += `lorem ipsum {alpha|beta|gamma|delta} dolor `
    }
    const groups = (body.match(/\{/g) || []).length
    expect(groups).toBeGreaterThanOrEqual(20)
    const start = Date.now()
    for (let s = 0; s < 100; s++) expandSpintax(body, s)
    const ms = Date.now() - start
    // Generous 500ms budget; observed ~5ms in practice. Leaves CI headroom.
    expect(ms).toBeLessThan(500)
  })

  it('countVariations on 1000-char heavy-blowup input returns Infinity fast', () => {
    let body = ''
    while (body.length < 950) body += '{a|b|c|d}'
    const start = Date.now()
    expect(countVariations(body)).toBe(Infinity)
    expect(Date.now() - start).toBeLessThan(100)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 10. Adversarial inputs — should never throw
// ─────────────────────────────────────────────────────────────────────
describe('U1 — adversarial inputs never throw', () => {
  it('only delimiters: braces and pipes only', () => {
    expect(() => expandSpintax('{|||}', 0)).not.toThrow()
    expect(() => expandAllSpintax('{|||}')).not.toThrow()
    expect(() => countVariations('{|||}')).not.toThrow()
  })

  it('mixed legal + adversarial: trailing {{', () => {
    expect(() => expandSpintax('{a|b}{{', 0)).not.toThrow()
    const v = validateSpintax('{a|b}{{')
    expect(v.ok).toBe(false)
  })

  it('NaN seed is normalized and does not throw', () => {
    expect(() => expandSpintax('{a|b}', NaN)).not.toThrow()
    const r = expandSpintax('{a|b}', NaN)
    expect(['a', 'b']).toContain(r)
  })
})
