// @tautology-fixtures: this file feeds code-as-strings into the analyzer it tests
// A7 — pre-commit ratchet tests.

import { describe, it, expect } from 'vitest'
import {
  checkScoreDelta,
  checkNewTestAssertions,
  checkMockWithoutImport,
} from '../../../scripts/halluc-precommit.mjs'

describe('checkScoreDelta', () => {
  it('T-1: ok when no baseline yet', () => {
    expect(checkScoreDelta({ current: { score: 80 }, prev: null, maxDrop: 5 }).ok).toBe(true)
  })

  it('T-2: ok when score equal', () => {
    const r = checkScoreDelta({ current: { score: 80 }, prev: { score: 80 }, maxDrop: 5 })
    expect(r.ok).toBe(true)
    expect(r.drop).toBe(0)
  })

  it('T-3: ok when drop is within budget', () => {
    const r = checkScoreDelta({ current: { score: 76 }, prev: { score: 80 }, maxDrop: 5 })
    expect(r.ok).toBe(true)
  })

  it('T-4: blocks when drop exceeds budget', () => {
    const r = checkScoreDelta({ current: { score: 70 }, prev: { score: 80 }, maxDrop: 5 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/dropped 10/)
  })

  it('T-5: ok when score increased', () => {
    const r = checkScoreDelta({ current: { score: 90 }, prev: { score: 80 }, maxDrop: 5 })
    expect(r.ok).toBe(true)
    expect(r.drop).toBe(-10)
  })
})

describe('checkNewTestAssertions', () => {
  function fakeGet(map) {
    return f => (f in map ? map[f] : null)
  }

  it('T-6: flags blocks below threshold', () => {
    const content = `
      it('weak', () => { expect(x).toBeDefined() })
    `
    const v = checkNewTestAssertions(['x.test.js'], fakeGet({ 'x.test.js': content }), 2)
    expect(v).toHaveLength(1)
    expect(v[0].block).toBe('weak')
    expect(v[0].assertions).toBe(1)
  })

  it('T-7: passes blocks at threshold', () => {
    const content = `
      it('strong', () => { expect(x).toBe(1); expect(y).toBe(2) })
    `
    const v = checkNewTestAssertions(['x.test.js'], fakeGet({ 'x.test.js': content }), 2)
    expect(v).toHaveLength(0)
  })

  it('T-8: ignores non-test files', () => {
    const v = checkNewTestAssertions(['src/lib/foo.js'], fakeGet({}))
    expect(v).toHaveLength(0)
  })

  it('T-9: ignores files where getContent returns null (deleted)', () => {
    const v = checkNewTestAssertions(['x.test.js'], fakeGet({}))
    expect(v).toHaveLength(0)
  })

  it('T-10: handles multiple flagged blocks per file', () => {
    const content = `
      it('a', () => {})
      it('b', () => { expect(1).toBe(1) })
      it('c', () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3) })
    `
    const v = checkNewTestAssertions(['x.test.js'], fakeGet({ 'x.test.js': content }), 2)
    expect(v).toHaveLength(2)
    expect(v.map(x => x.block).sort()).toEqual(['a', 'b'])
  })
})

describe('checkMockWithoutImport', () => {
  function fakeGet(map) {
    return f => (f in map ? map[f] : null)
  }

  it('T-11: flags vi.mock without matching import', () => {
    const content = `
      vi.mock('../../../src/store', () => ({}))
      // Forgot to import useStore
    `
    const v = checkMockWithoutImport(['x.test.js'], fakeGet({ 'x.test.js': content }))
    expect(v).toHaveLength(1)
    expect(v[0].mocked).toBe('../../../src/store')
  })

  it('T-12: passes when mock + matching import are both present', () => {
    const content = `
      vi.mock('../../../src/store', () => ({}))
      import useStore from '../../../src/store'
    `
    const v = checkMockWithoutImport(['x.test.js'], fakeGet({ 'x.test.js': content }))
    expect(v).toHaveLength(0)
  })

  it('T-13: dynamic import counts toward import set', () => {
    const content = `
      vi.mock('../../../src/lib/foo.js', () => ({}))
      const { x } = await import('../../../src/lib/foo.js')
    `
    const v = checkMockWithoutImport(['x.test.js'], fakeGet({ 'x.test.js': content }))
    expect(v).toHaveLength(0)
  })

  it('T-14: ignores non-test files', () => {
    const content = `vi.mock('whatever')`
    const v = checkMockWithoutImport(['src/lib/foo.js'], fakeGet({ 'src/lib/foo.js': content }))
    expect(v).toHaveLength(0)
  })

  it('T-15: handles multiple violations per file', () => {
    const content = `
      vi.mock('../foo', () => ({}))
      vi.mock('../bar', () => ({}))
      vi.mock('../baz', () => ({}))
      import xx from '../baz'
    `
    const v = checkMockWithoutImport(['x.test.js'], fakeGet({ 'x.test.js': content }))
    expect(v).toHaveLength(2)
    expect(v.map(x => x.mocked).sort()).toEqual(['../bar', '../foo'])
  })
})
