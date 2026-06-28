import { describe, expect, it } from 'vitest'
import { T, readDensityTokens } from '../../../src/lib/tokens'

describe('tokens — text scale', () => {
  it('exposes all canonical text sizes', () => {
    expect(T.text['2xs']).toBe(10)
    expect(T.text.xs).toBe(11)
    expect(T.text.sm).toBe(12)
    expect(T.text.base).toBe(13)
    expect(T.text.md).toBe(14)
    expect(T.text.lg).toBe(15)
    expect(T.text.xl).toBe(19)
    expect(T.text['2xl']).toBe(24)
    expect(T.text['3xl']).toBe(31)
  })
  it('text scale is monotonically non-decreasing', () => {
    const seq = [T.text['2xs'], T.text.xs, T.text.sm, T.text.base, T.text.md, T.text.lg, T.text.xl, T.text['2xl'], T.text['3xl']]
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
  })
  it('text values are all numbers', () => {
    for (const k of Object.keys(T.text)) expect(typeof T.text[k]).toBe('number')
  })
})

describe('tokens — spacing scale T.s()', () => {
  it('returns fixed spacing at defined steps', () => {
    expect(T.s(0)).toBe(2)
    expect(T.s(1)).toBe(3)
    expect(T.s(2)).toBe(6)
    expect(T.s(3)).toBe(10)
    expect(T.s(4)).toBe(13)
    expect(T.s(5)).toBe(15)
    expect(T.s(6)).toBe(19)
    expect(T.s(7)).toBe(25)
    expect(T.s(8)).toBe(37)
    expect(T.s(9)).toBe(51)
    expect(T.s(10)).toBe(76)
  })
  it('returns raw value for unknown step', () => {
    expect(T.s(99)).toBe(99)
    expect(T.s(0.5)).toBe(0.5)
  })
  it('spacing scale is monotonically increasing', () => {
    for (let i = 1; i <= 10; i++) expect(T.s(i)).toBeGreaterThan(T.s(i - 1))
  })
})

describe('tokens — icon scale', () => {
  it('exposes canonical icon sizes', () => {
    expect(T.icon['2xs']).toBe(8)
    expect(T.icon.xs).toBe(10)
    expect(T.icon.sm).toBe(11)
    expect(T.icon.md).toBe(13)
    expect(T.icon.lg).toBe(14)
    expect(T.icon.xl).toBe(18)
    expect(T.icon['2xl']).toBe(22)
    expect(T.icon['3xl']).toBe(32)
  })
  it('icon scale is monotonically non-decreasing', () => {
    const seq = [T.icon['2xs'], T.icon.xs, T.icon.sm, T.icon.md, T.icon.lg, T.icon.xl, T.icon['2xl'], T.icon['3xl']]
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
  })
})

describe('tokens — radius', () => {
  it('exposes radius tokens', () => {
    expect(T.radius.sm).toBe(3)
    expect(T.radius.base).toBe(4)
    expect(T.radius.lg).toBe(7)
  })
  it('radius sm ≤ base ≤ lg', () => {
    expect(T.radius.sm).toBeLessThanOrEqual(T.radius.base)
    expect(T.radius.base).toBeLessThanOrEqual(T.radius.lg)
  })
})

describe('tokens — readDensityTokens()', () => {
  it('returns live shape under jsdom', () => {
    const live = readDensityTokens()
    expect(live).toBeDefined()
    expect(live.text).toBeDefined()
    expect(live.icon).toBeDefined()
  })
  it('falls back to static T when css vars unset', () => {
    const live = readDensityTokens()
    expect(live.text.sm).toBe(T.text.sm)
    expect(live.text.base).toBe(T.text.base)
    expect(live.icon.md).toBe(T.icon.md)
  })
  it('does not throw on repeat call', () => {
    expect(() => readDensityTokens()).not.toThrow()
    expect(() => readDensityTokens()).not.toThrow()
  })
})

describe('tokens — exports are frozen-ish (shape stability)', () => {
  it('text key count', () => expect(Object.keys(T.text).length).toBe(9))
  it('icon key count', () => expect(Object.keys(T.icon).length).toBe(8))
  it('radius key count', () => expect(Object.keys(T.radius).length).toBe(3))
  it('T.s is a function', () => expect(typeof T.s).toBe('function'))
})
