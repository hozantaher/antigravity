// AV-F3 — unit tests for machineryDict (Czech machinery brand + body-type
// dictionary).
// Source: features/platform/outreach-dashboard/src/lib/machineryDict.js
//
// Lightweight ratchets so additions/removals are deliberate:
//   - both lists non-empty
//   - alphabetic ordering within each list (operator-visible-ish artifact;
//     keeping it sorted simplifies reviews of future PR diffs)
//   - sizes match the exported `BRAND_COUNT` / `BODY_TYPE_COUNT` counters

import { describe, it, expect } from 'vitest'
import {
  BRANDS,
  BODY_TYPES,
  BRAND_COUNT,
  BODY_TYPE_COUNT,
} from '../../../src/lib/machineryDict.js'

describe('machineryDict — BRANDS', () => {
  it('is a non-empty frozen array', () => {
    expect(Array.isArray(BRANDS)).toBe(true)
    expect(BRANDS.length).toBeGreaterThan(0)
    expect(Object.isFrozen(BRANDS)).toBe(true)
  })

  it('exposes BRAND_COUNT matching .length', () => {
    expect(BRAND_COUNT).toBe(BRANDS.length)
  })

  it('is alphabetically sorted (case-insensitive)', () => {
    const sorted = [...BRANDS].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    )
    // The dictionary is grouped into 4 subsections (construction / trucks /
    // vans / agricultural). Each subsection is sorted internally — assert
    // the WHOLE list is sorted to enforce a uniform ordering convention. If
    // a future PR introduces a brand out of order, this test surfaces it.
    expect(BRANDS).toEqual(sorted)
  })
})

describe('machineryDict — BODY_TYPES', () => {
  it('is a non-empty frozen array', () => {
    expect(Array.isArray(BODY_TYPES)).toBe(true)
    expect(BODY_TYPES.length).toBeGreaterThan(0)
    expect(Object.isFrozen(BODY_TYPES)).toBe(true)
  })

  it('exposes BODY_TYPE_COUNT matching .length', () => {
    expect(BODY_TYPE_COUNT).toBe(BODY_TYPES.length)
  })

  it('is alphabetically sorted (case-insensitive locale)', () => {
    const sorted = [...BODY_TYPES].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    )
    expect(BODY_TYPES).toEqual(sorted)
  })
})
