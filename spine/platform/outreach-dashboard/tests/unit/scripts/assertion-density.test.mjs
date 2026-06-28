// @tautology-fixtures: this file feeds code-as-strings into the analyzer it tests
// A3 — assertion-density audit tests.

import { describe, it, expect } from 'vitest'
import { analyzeBlock, extractTestBlocks, analyzeFile } from '../../../scripts/assertion-density.mjs'

describe('assertion-density — extractTestBlocks', () => {
  it('T-1: finds it() blocks by name', () => {
    const src = `
      describe('foo', () => {
        it('does X', () => { expect(1).toBe(1) })
        it('does Y', () => { expect(2).toBe(2) })
      })
    `
    const blocks = extractTestBlocks(src)
    expect(blocks.map(b => b.name)).toEqual(['does X', 'does Y'])
  })

  it('T-2: finds test() blocks too', () => {
    const src = `test('alpha', () => { expect(1).toBe(1) })`
    const blocks = extractTestBlocks(src)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].name).toBe('alpha')
  })

  it('T-3: finds it.skip / it.only modifiers', () => {
    const src = `
      it.skip('skipped', () => {})
      it.only('only', () => {})
    `
    const blocks = extractTestBlocks(src)
    expect(blocks.map(b => b.name).sort()).toEqual(['only', 'skipped'])
  })

  it('T-4: handles nested parens in body', () => {
    const src = `
      it('foo', () => {
        expect(JSON.stringify({a: (1 + 2)})).toBe('{"a":3}')
      })
    `
    const blocks = extractTestBlocks(src)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].body).toContain('JSON.stringify')
  })

  it('T-5: ignores parens inside string literals', () => {
    const src = `it('foo', () => { const s = ')(' ; expect(s).toBe(')(') })`
    const blocks = extractTestBlocks(src)
    expect(blocks).toHaveLength(1)
  })

  it('T-6: ignores parens inside template literals', () => {
    const src = "it('foo', () => { const s = `)(`; expect(s.length).toBe(2) })"
    const blocks = extractTestBlocks(src)
    expect(blocks).toHaveLength(1)
  })

  it('T-7: ignores parens inside line comments', () => {
    const src = `it('foo', () => {
      // ) ignore me
      expect(1).toBe(1)
    })`
    const blocks = extractTestBlocks(src)
    expect(blocks).toHaveLength(1)
  })

  it('T-8: ignores parens inside block comments', () => {
    const src = `it('foo', () => {
      /* ) ignore */
      expect(1).toBe(1)
    })`
    const blocks = extractTestBlocks(src)
    expect(blocks).toHaveLength(1)
  })
})

describe('assertion-density — analyzeBlock', () => {
  it('T-9: counts expect() calls', () => {
    const body = `() => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3) }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBe(3)
  })

  it('T-10: flags low-density only when zero assertions (with default min=1)', () => {
    const noAssert = `() => { console.log('hi') }`
    expect(analyzeBlock('x', noAssert).flags.some(f => f.startsWith('low-density'))).toBe(true)
    const oneAssert = `() => { expect(x).toBeDefined() }`
    // With default min=1, a single assertion is fine.
    expect(analyzeBlock('x', oneAssert).flags.some(f => f.startsWith('low-density'))).toBe(false)
  })

  it('T-11: detects expect(true).toBe(true) constant tautology', () => {
    const body = `() => { expect(true).toBe(true) }`
    const r = analyzeBlock('x', body)
    expect(r.tautologies.length).toBeGreaterThan(0)
    expect(r.flags).toContain('tautology')
  })

  it('T-12: detects expect(getX()).toBe(getX()) same-side tautology', () => {
    const body = `() => { expect(getX()).toBe(getX()); expect(2).toBe(2) }`
    const r = analyzeBlock('x', body)
    expect(r.tautologies.some(t => t.includes('identical'))).toBe(true)
  })

  it('T-13: flags only-safe-matchers when only toBeDefined used', () => {
    const body = `() => { expect(a).toBeDefined(); expect(b).toBeDefined() }`
    const r = analyzeBlock('x', body)
    expect(r.flags).toContain('only-safe-matchers')
  })

  it('T-14: does not flag mixed safe + value matchers', () => {
    const body = `() => { expect(a).toBeDefined(); expect(b).toBe(2) }`
    const r = analyzeBlock('x', body)
    expect(r.flags).not.toContain('only-safe-matchers')
  })

  it('T-15: flags zero-assertion blocks', () => {
    const body = `() => { console.log('hi') }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBe(0)
    expect(r.flags.some(f => f.startsWith('low-density'))).toBe(true)
  })

  it('T-16: high density with rich matchers passes clean', () => {
    const body = `() => {
      expect(result.value).toBe(42)
      expect(result.kind).toBe('user')
      expect(result.items).toHaveLength(3)
    }`
    const r = analyzeBlock('x', body)
    expect(r.flags).toHaveLength(0)
  })
})

describe('assertion-density — analyzeFile aggregate', () => {
  it('T-17: aggregates blocks count and average', () => {
    const src = `
      it('a', () => { expect(1).toBe(1); expect(2).toBe(2) })
      it('b', () => { expect(3).toBe(3); expect(4).toBe(4); expect(5).toBe(5) })
    `
    const r = analyzeFile('/x.test.js', src)
    expect(r.total).toBe(2)
    // Both have constant tautologies but expect counts matter
    expect(r.avg_expects).toBeGreaterThan(2)
  })

  it('T-18: file with mostly clean blocks reports low flagged count', () => {
    const src = `
      it('clean', () => {
        expect(value.x).toBe(1)
        expect(value.y).toBe('hello')
        expect(typeof fn).toBe('function')
      })
    `
    const r = analyzeFile('/x.test.js', src)
    expect(r.blocks.length).toBe(0)
  })

  it('T-19: file with all-zero-assertion blocks surfaces them', () => {
    const src = `
      it('a', () => {})
      it('b', () => {})
    `
    const r = analyzeFile('/x.test.js', src)
    expect(r.low_density).toBe(2)
    expect(r.blocks.length).toBe(2)
  })

  it('T-20: tautology in file surfaces in tautology_count', () => {
    const src = `
      it('a', () => { expect(true).toBe(true); expect(2).toBe(2) })
    `
    const r = analyzeFile('/x.test.js', src)
    expect(r.tautology_count).toBe(1)
  })
})

describe('assertion-density — non-expect assertions counted', () => {
  it('T-21: fc.assert(...) counts as assertion', () => {
    const body = `() => { fc.assert(fc.property(fc.integer(), n => n + 0 === n)) }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBeGreaterThanOrEqual(1)
  })

  it('T-22: assertHistogramBounded helper counts as assertion', () => {
    const body = `() => { assertHistogramBounded(samples, 100, 200) }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBeGreaterThanOrEqual(1)
  })

  it('T-23: invariant() call counts as assertion', () => {
    const body = `() => { invariant(state.healthy, 'must be healthy') }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBeGreaterThanOrEqual(1)
  })

  it('T-24: assertEqual / assertDeep count as assertions', () => {
    const body = `() => { assertEqual(a, b); assertDeep(c, d) }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBeGreaterThanOrEqual(2)
  })

  it('T-25: mixed expect + custom assert deduplicate but both count', () => {
    const body = `() => { expect(x).toBe(1); assertEqual(y, 2); fc.assert(p) }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBe(3)
  })

  it('T-25b: custom assertSafeResponse-style camelCase counts as assertion', () => {
    const body = `() => { assertSafeResponse(r, 'A5') }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBeGreaterThanOrEqual(1)
  })

  it('T-25c: bare assert(...) counts as assertion (vitest/node assert)', () => {
    const body = `() => { assert(x === 5) }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBeGreaterThanOrEqual(1)
  })

  it('T-25d: expectXxx(...) helper counts (e.g. expectSqlstate)', () => {
    const body = `() => { await expectSqlstate(sql, '23502') }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBeGreaterThanOrEqual(1)
  })

  it('T-25e: bare expect.something(...) still counts', () => {
    const body = `() => { expect.assertions(2) }`
    const r = analyzeBlock('x', body)
    expect(r.expectCount).toBeGreaterThanOrEqual(1)
  })
})

describe('assertion-density — @analyzer-self-test marker', () => {
  it('T-26: file marked @tautology-fixtures suppresses tautology flags', () => {
    const src = `
      // @tautology-fixtures: code-as-strings input
      it('a', () => { expect(true).toBe(true); expect(2).toBe(2) })
    `
    const r = analyzeFile('/x.test.js', src)
    expect(r.tautology_count).toBe(0)
    expect(r.blocks.every(b => !b.flags.includes('tautology'))).toBe(true)
  })

  it('T-27: unmarked file still flags tautologies', () => {
    const src = `
      it('a', () => { expect(true).toBe(true); expect(2).toBe(2) })
    `
    const r = analyzeFile('/x.test.js', src)
    expect(r.tautology_count).toBeGreaterThan(0)
  })

  it('T-27b: @analyzer-self-test suppresses low-density too', () => {
    const src = `
      // @analyzer-self-test: fixture file
      it('a', () => {})
      it('b', () => {})
    `
    const r = analyzeFile('/x.test.js', src)
    expect(r.low_density).toBe(0)
  })

  it('T-27c: unmarked file still flags low-density', () => {
    const src = `
      it('a', () => {})
      it('b', () => {})
    `
    const r = analyzeFile('/x.test.js', src)
    expect(r.low_density).toBe(2)
  })
})
