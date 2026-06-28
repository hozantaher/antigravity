// A1 — spintax property tests (fast-check).
// Invariants checked over thousands of random spintax strings.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  expandSpintax,
  expandAllSpintax,
  countVariations,
} from '../../../src/lib/spintax.js'

// Generator: well-formed spintax with bounded depth.
// Recursion-bounded: depth 0 → leaf word, depth>0 → maybe a group.
function arbSpintax(depth = 2) {
  const leaf = fc.stringMatching(/^[a-zA-Z0-9 ]{1,8}$/)
  if (depth === 0) return leaf
  const branch = fc.oneof(
    leaf,
    fc.tuple(leaf, arbSpintax(depth - 1), leaf).map(([a, b, c]) => a + b + c)
  )
  const group = fc.array(branch, { minLength: 2, maxLength: 4 })
    .map(parts => '{' + parts.join('|') + '}')
  return fc.oneof({ weight: 2, arbitrary: leaf }, { weight: 1, arbitrary: group })
}

describe('property: expandSpintax always picks a valid branch', () => {
  it('result is one of expandAllSpintax for the same text', () => {
    fc.assert(
      fc.property(arbSpintax(2), fc.integer({ min: 0, max: 10_000 }), (text, seed) => {
        const all = expandAllSpintax(text, { cap: 1024 })
        const got = expandSpintax(text, seed)
        // got must be in the set of all possible expansions
        return all.includes(got)
      }),
      { numRuns: 200 }
    )
  })
})

describe('property: deterministic for same seed', () => {
  it('same seed → same output, always', () => {
    fc.assert(
      fc.property(arbSpintax(2), fc.integer({ min: 0, max: 1_000_000 }), (text, seed) => {
        return expandSpintax(text, seed) === expandSpintax(text, seed)
      }),
      { numRuns: 200 }
    )
  })
})

describe('property: countVariations matches expandAll length when not capped', () => {
  it('count >= unique(expandAll length) for cap-bounded inputs', () => {
    fc.assert(
      fc.property(arbSpintax(1), text => {
        const count = countVariations(text)
        const all = expandAllSpintax(text, { cap: 10_000 })
        if (count === Infinity) return all.length <= 10_000
        // expandAll may dedupe → all.length ≤ count
        return all.length <= count
      }),
      { numRuns: 200 }
    )
  })
})

describe('property: well-formed spintax never leaves trailing braces', () => {
  it('after expansion, no { or } remain when input was balanced', () => {
    fc.assert(
      fc.property(arbSpintax(2), fc.integer({ min: 0, max: 1000 }), (text, seed) => {
        // arbSpintax produces only balanced outputs (always closes groups).
        const r = expandSpintax(text, seed)
        return !r.includes('{') && !r.includes('}')
      }),
      { numRuns: 200 }
    )
  })
})

describe('property: idempotent on plain text', () => {
  it('strings without {|} pass through unchanged regardless of seed', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }).filter(s => !/[{}|]/.test(s)),
        fc.integer({ min: 0, max: 1000 }),
        (text, seed) => expandSpintax(text, seed) === text
      ),
      { numRuns: 100 }
    )
  })
})
