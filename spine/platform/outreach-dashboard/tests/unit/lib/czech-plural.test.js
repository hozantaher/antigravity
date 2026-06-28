import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { schranka, verbForm, plural } from '../../../src/lib/czech-plural'

describe('schranka(n) — Czech feminine pluralization', () => {
  it('n=1 → nominative singular "schránka"', () => {
    expect(schranka(1)).toBe('schránka')
  })

  it('n=2,3,4 → nominative plural "schránky"', () => {
    expect(schranka(2)).toBe('schránky')
    expect(schranka(3)).toBe('schránky')
    expect(schranka(4)).toBe('schránky')
  })

  it('n=0 → genitive plural "schránek"', () => {
    expect(schranka(0)).toBe('schránek')
  })

  it('n=5..10 → genitive plural', () => {
    for (let i = 5; i <= 10; i++) expect(schranka(i)).toBe('schránek')
  })

  it('n=11..14 — the anomaly window — MUST be genitive plural', () => {
    expect(schranka(11)).toBe('schránek')
    expect(schranka(12)).toBe('schránek')
    expect(schranka(13)).toBe('schránek')
    expect(schranka(14)).toBe('schránek')
  })

  it('n=15..20 → genitive plural', () => {
    for (let i = 15; i <= 20; i++) expect(schranka(i)).toBe('schránek')
  })

  it('n=21..24 — compound-1..4 numbers still use genitive plural', () => {
    // Even though 21 ends in "1", the composite "21" in formal Czech numeric
    // grammar uses genitive plural ("dvacet jedna schránek"). We lock this
    // rule to prevent a naive digit-tail hack from shipping.
    expect(schranka(21)).toBe('schránek')
    expect(schranka(22)).toBe('schránek')
    expect(schranka(23)).toBe('schránek')
    expect(schranka(24)).toBe('schránek')
  })

  it('n=100, 101, 1000 → genitive plural', () => {
    expect(schranka(100)).toBe('schránek')
    expect(schranka(101)).toBe('schránek')
    expect(schranka(1000)).toBe('schránek')
  })

  it('treats negative input as absolute value', () => {
    expect(schranka(-1)).toBe('schránka')
    expect(schranka(-3)).toBe('schránky')
    expect(schranka(-11)).toBe('schránek')
  })

  it('truncates non-integer input', () => {
    expect(schranka(1.9)).toBe('schránka')   // 1.9 → 1
    expect(schranka(2.4)).toBe('schránky')   // 2.4 → 2
    expect(schranka(4.9)).toBe('schránky')   // 4.9 → 4
    expect(schranka(5.1)).toBe('schránek')   // 5.1 → 5
  })
})

describe('schranka(n) — property tests (fast-check)', () => {
  it('ALWAYS returns one of the 3 valid forms for any non-negative integer 0..10000', () => {
    const VALID = new Set(['schránka', 'schránky', 'schránek'])
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10000 }), (n) => {
        return VALID.has(schranka(n))
      }),
      { numRuns: 500 }
    )
  })

  it('FOR n >= 5 AND n != 1,2,3,4: always genitive (except none — lock the 5+ rule)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 10000 }), (n) => {
        return schranka(n) === 'schránek'
      }),
      { numRuns: 200 }
    )
  })

  it('FOR n in 2..4: always plural (no integer inside this window is genitive)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 4 }), (n) => {
        return schranka(n) === 'schránky'
      })
    )
  })

  it('is referentially transparent (pure fn, no side effects)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10000 }), (n) => {
        const a = schranka(n)
        const b = schranka(n)
        return a === b
      }),
      { numRuns: 100 }
    )
  })
})

describe('verbForm(n)', () => {
  it('n=1 → "má"', () => {
    expect(verbForm(1)).toBe('má')
  })

  it('n=0,2,3,...,100 → "mají"', () => {
    expect(verbForm(0)).toBe('mají')
    for (let i = 2; i <= 100; i++) expect(verbForm(i)).toBe('mají')
  })

  it('property: for every n != 1, returns "mají"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10000 }).filter((n) => n !== 1), (n) => {
        return verbForm(n) === 'mají'
      }),
      { numRuns: 300 }
    )
  })
})

describe('plural(n, forms) — generic', () => {
  it('drives any feminine noun via custom form map', () => {
    const FIRMA = { singular: 'firma', plural: 'firmy', genitive: 'firem' }
    expect(plural(1, FIRMA)).toBe('firma')
    expect(plural(3, FIRMA)).toBe('firmy')
    expect(plural(0, FIRMA)).toBe('firem')
    expect(plural(11, FIRMA)).toBe('firem')
    expect(plural(100, FIRMA)).toBe('firem')
  })

  it('works for masculine nouns (e.g., kontakt/kontakty/kontaktů)', () => {
    const KONTAKT = { singular: 'kontakt', plural: 'kontakty', genitive: 'kontaktů' }
    expect(plural(1, KONTAKT)).toBe('kontakt')
    expect(plural(2, KONTAKT)).toBe('kontakty')
    expect(plural(5, KONTAKT)).toBe('kontaktů')
    expect(plural(13, KONTAKT)).toBe('kontaktů')
  })
})
