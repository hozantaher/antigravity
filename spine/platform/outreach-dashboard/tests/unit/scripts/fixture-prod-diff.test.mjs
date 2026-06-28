// A1 — fixture-prod-diff: shape inference + diff tests.

import { describe, it, expect } from 'vitest'
import { inferShape, diffShapes } from '../../../scripts/fixture-prod-diff.mjs'

describe('inferShape', () => {
  it('T-1: scalars return their typeof', () => {
    expect(inferShape(42)).toBe('number')
    expect(inferShape('hello')).toBe('string')
    expect(inferShape(true)).toBe('boolean')
  })

  it('T-2: null returns "null"', () => {
    expect(inferShape(null)).toBe('null')
  })

  it('T-3: empty array returns array<unknown>', () => {
    expect(inferShape([])).toBe('array<unknown>')
  })

  it('T-4: array of homogeneous primitives', () => {
    expect(inferShape([1, 2, 3])).toBe('array<number>')
    expect(inferShape(['a', 'b'])).toBe('array<string>')
  })

  it('T-5: heterogeneous array marked', () => {
    expect(inferShape([1, 'a'])).toBe('array<heterogeneous>')
  })

  it('T-6: object returns sorted-key shape', () => {
    const s = inferShape({ b: 1, a: 'x' })
    expect(s).toEqual({ a: 'string', b: 'number' })
  })

  it('T-7: nested object recurses', () => {
    const s = inferShape({ user: { name: 'x', age: 30 } })
    expect(s).toEqual({ user: { age: 'number', name: 'string' } })
  })

  it('T-8: deep recursion truncates with <deep>', () => {
    let v = 0
    for (let i = 0; i < 8; i++) v = { nested: v }
    const s = inferShape(v)
    const json = JSON.stringify(s)
    expect(json).toContain('<deep>')
  })
})

describe('diffShapes', () => {
  it('T-9: identical shapes → no drift', () => {
    const a = { x: 'number', y: 'string' }
    expect(diffShapes(a, a)).toEqual([])
  })

  it('T-10: missing field in fixture surfaces fixture-missing-field', () => {
    const prod = { x: 'number', y: 'string' }
    const fixture = { x: 'number' }
    const drift = diffShapes(prod, fixture)
    expect(drift).toEqual([{ path: '.y', kind: 'fixture-missing-field' }])
  })

  it('T-11: extra field in fixture surfaces fixture-extra-field', () => {
    const prod = { x: 'number' }
    const fixture = { x: 'number', y: 'string' }
    const drift = diffShapes(prod, fixture)
    expect(drift).toEqual([{ path: '.y', kind: 'fixture-extra-field' }])
  })

  it('T-12: type change in leaf surfaces leaf-type', () => {
    const prod = { x: 'number' }
    const fixture = { x: 'string' }
    const drift = diffShapes(prod, fixture)
    expect(drift[0].kind).toBe('leaf-type')
    expect(drift[0].from).toBe('string')
    expect(drift[0].to).toBe('number')
  })

  it('T-13: nested mismatch reports correct path', () => {
    const prod = { a: { b: 'number' } }
    const fixture = { a: { b: 'string' } }
    const drift = diffShapes(prod, fixture)
    expect(drift[0].path).toBe('.a.b')
  })

  it('T-14: object-vs-array mismatch flagged', () => {
    const prod = ['array<number>']
    const fixture = { x: 'number' }
    const drift = diffShapes(prod, fixture)
    expect(drift.some(d => d.kind === 'array-vs-object')).toBe(true)
  })

  it('T-15: handles null on either side without throwing', () => {
    expect(() => diffShapes(null, { x: 'number' })).not.toThrow()
    expect(() => diffShapes({ x: 'number' }, null)).not.toThrow()
  })

  it('T-16: deep equal nested objects produce zero drift', () => {
    const both = { user: { name: 'string', addr: { city: 'string' } } }
    const drift = diffShapes(both, JSON.parse(JSON.stringify(both)))
    expect(drift).toEqual([])
  })
})
