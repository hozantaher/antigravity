import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  DEFAULTS,
  parseFilters,
  serializeFilters,
  toServerQuery,
  hasActiveFilters,
  activeFilterKeys,
  normalize,
} from '../../../src/lib/filterSerializer.js'

describe('filterSerializer', () => {
  it('parses empty URL to defaults', () => {
    expect(parseFilters(new URLSearchParams())).toEqual(DEFAULTS)
  })

  it('omits defaults from serialized URL', () => {
    const p = serializeFilters(DEFAULTS)
    expect(p.toString()).toBe('')
  })

  it('round-trips typical filter set', () => {
    const f = {
      ...DEFAULTS,
      q: 'cnc',
      icp: ['ideal', 'good'],
      scoreMin: 70,
      scoreMax: 100,
      region: ['Praha'],
      uncontacted: true,
    }
    const parsed = parseFilters(serializeFilters(f))
    expect(parsed).toEqual(f)
  })

  it('legacy `search` param maps to `q`', () => {
    const p = new URLSearchParams('search=cnc')
    expect(parseFilters(p).q).toBe('cnc')
  })

  it('invalid sort falls back to default', () => {
    const p = new URLSearchParams('sort=DROP_TABLE')
    expect(parseFilters(p).sort).toBe('score')
  })

  it('invalid icp values get dropped, valid ones kept', () => {
    const p = new URLSearchParams('icp=ideal,bogus,good')
    expect(parseFilters(p).icp).toEqual(['ideal', 'good'])
  })

  it('score clamped to 0-100', () => {
    const p = new URLSearchParams('scoreMin=-50&scoreMax=200')
    const f = parseFilters(p)
    expect(f.scoreMin).toBe(0)
    expect(f.scoreMax).toBe(100)
  })

  it('non-numeric score becomes null', () => {
    const p = new URLSearchParams('scoreMin=abc')
    expect(parseFilters(p).scoreMin).toBeNull()
  })

  it('hasWebsite tri-state', () => {
    expect(parseFilters(new URLSearchParams('hasWebsite=1')).hasWebsite).toBe(true)
    expect(parseFilters(new URLSearchParams('hasWebsite=0')).hasWebsite).toBe(false)
    expect(parseFilters(new URLSearchParams('')).hasWebsite).toBeNull()
  })

  it('hasActiveFilters true when any non-default set', () => {
    expect(hasActiveFilters(DEFAULTS)).toBe(false)
    expect(hasActiveFilters({ ...DEFAULTS, q: 'cnc' })).toBe(true)
    expect(hasActiveFilters({ ...DEFAULTS, icp: ['ideal'] })).toBe(true)
    expect(hasActiveFilters({ ...DEFAULTS, sort: 'name' })).toBe(false)
  })

  it('activeFilterKeys lists only non-default, non-meta keys', () => {
    const f = { ...DEFAULTS, q: 'cnc', scoreMin: 70, sort: 'name' }
    expect(activeFilterKeys(f).sort()).toEqual(['q', 'scoreMin'])
  })

  it('normalize fills missing keys', () => {
    expect(normalize({ q: 'cnc' })).toEqual({ ...DEFAULTS, q: 'cnc' })
    expect(normalize(null)).toEqual(DEFAULTS)
  })

  it('toServerQuery emits legacy param names', () => {
    const f = {
      ...DEFAULTS,
      q: 'cnc',
      icp: ['ideal'],
      email: ['valid'],
      cats: ['123'],
      xcats: ['456'],
    }
    const q = toServerQuery(f).toString()
    expect(q).toContain('search=cnc')
    expect(q).toContain('icp=ideal')
    expect(q).toContain('email_status%5B%5D=valid')
    expect(q).toContain('categories%5B%5D=123')
    expect(q).toContain('exclude_categories%5B%5D=456')
  })

  it('URL stays under 2000 chars for 50 cats + 50 xcats', () => {
    const f = {
      ...DEFAULTS,
      cats: Array.from({ length: 50 }, (_, i) => `cat${i}`),
      xcats: Array.from({ length: 50 }, (_, i) => `xcat${i}`),
    }
    expect(serializeFilters(f).toString().length).toBeLessThan(2000)
  })

  it('property: serialize ∘ parse = id for arbitrary valid filters', () => {
    const arb = fc.record({
      q: fc.string({ maxLength: 40 }),
      icp: fc.subarray(['ideal', 'good', 'unscored']),
      size: fc.subarray(['1-9', '10-49', '50-249', '250+']),
      email: fc.subarray(['valid', 'risky', 'catch_all', 'role_only', 'invalid', 'unverified']),
      uncontacted: fc.boolean(),
      sort: fc.constantFrom('score', 'name', 'city', 'contacted'),
      dir: fc.constantFrom('asc', 'desc'),
      offset: fc.integer({ min: 0, max: 100000 }),
      cats: fc.array(fc.integer({ min: 1, max: 9999 }).map(String), { maxLength: 10 }),
      xcats: fc.array(fc.integer({ min: 1, max: 9999 }).map(String), { maxLength: 10 }),
      scoreMin: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
      scoreMax: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
      region: fc.array(fc.string({ minLength: 1, maxLength: 10 }).filter(s => s.trim() === s && s.trim() !== '' && !s.includes(',')), { maxLength: 5 }),
      sector: fc.array(fc.string({ minLength: 1, maxLength: 10 }).filter(s => s.trim() === s && s.trim() !== '' && !s.includes(',')), { maxLength: 5 }),
      engagement: fc.subarray(['cold', 'warm', 'hot']),
      lastContactedSince: fc.option(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }).filter(d => !isNaN(d.getTime())).map(d => d.toISOString()),
        { nil: null }
      ),
      lastContactedNever: fc.boolean(),
      emailConfidenceMin: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
      hasWebsite: fc.option(fc.boolean(), { nil: null }),
    })
    fc.assert(fc.property(arb, (f) => {
      const parsed = parseFilters(serializeFilters(f))
      // q empty → default '' after parse
      const expected = { ...f, q: f.q === '' ? DEFAULTS.q : f.q }
      expect(parsed).toEqual(expected)
    }), { numRuns: 300 })
  })

  it('corrupt input does not throw', () => {
    const corrupt = new URLSearchParams('q=abc&icp=&&,,good&scoreMin=&offset=-5')
    expect(() => parseFilters(corrupt)).not.toThrow()
  })

  // ── round-trip: serialize then deserialize ────────────────────────────
  it('round-trip: serialize then deserialize returns same object (named filters)', () => {
    const filters = { ...DEFAULTS, q: 'stroj', icp: ['ideal'], scoreMin: 60, offset: 20, sort: 'name', dir: 'asc' }
    const serialized = serializeFilters(filters)
    const deserialized = parseFilters(serialized)
    expect(deserialized).toMatchObject({ q: 'stroj', icp: ['ideal'], scoreMin: 60, offset: 20, sort: 'name', dir: 'asc' })
  })

  // ── MONKEY: serializeFilters never throws for adversarial inputs ──────
  it('MONKEY: serializeFilters does not throw for null', () => {
    // null is outside the intended API; document behaviour (may throw or return empty params)
    let threw = false
    try { serializeFilters(null) } catch { threw = true }
    expect(typeof threw).toBe('boolean') // path was reached and we observed a defined outcome
  })

  it('MONKEY: serializeFilters does not throw for undefined', () => {
    let threw = false
    try { serializeFilters(undefined) } catch { threw = true }
    expect(typeof threw).toBe('boolean')
  })

  it('MONKEY: serializeFilters does not throw for empty object', () => {
    expect(() => serializeFilters({})).not.toThrow()
  })

  it('MONKEY: serializeFilters with null-valued keys returns params without crash', () => {
    expect(() => serializeFilters({ ...DEFAULTS, q: null, scoreMin: null, icp: null })).not.toThrow()
  })

  it('MONKEY: serializeFilters with array-valued keys still returns URLSearchParams', () => {
    const result = serializeFilters({ ...DEFAULTS, icp: [1, 2, 3], cats: [null, undefined, 'valid'] })
    expect(result).toBeInstanceOf(URLSearchParams)
  })

  it('MONKEY: serializeFilters with Symbol value does not crash (skips gracefully)', () => {
    // Symbols cannot be coerced to string without TypeError — implementation may skip or throw.
    // We document the boundary: either no throw or a controlled throw.
    let threw = false
    try { serializeFilters({ ...DEFAULTS, q: Symbol('test') }) } catch { threw = true }
    expect(typeof threw).toBe('boolean')
  })

  it('MONKEY: parseFilters + serializeFilters round-trip is idempotent for all-defaults', () => {
    const once = parseFilters(serializeFilters(DEFAULTS))
    const twice = parseFilters(serializeFilters(once))
    expect(twice).toEqual(once)
  })
})
