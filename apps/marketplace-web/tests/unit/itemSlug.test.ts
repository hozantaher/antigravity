import { describe, expect, it } from 'vitest'
import { itemSlug, itemPath, type Item } from '~/models'

const item = (overrides: Partial<Item> = {}): Item => ({ id: 'i1', title: '', ...overrides }) as never

describe('itemSlug', () => {
  it('slugifies a plain title', () => {
    expect(itemSlug(item({ title: 'BMW X5 3.0d' }))).toBe('bmw-x5-3-0d')
  })

  it('strips diacritics', () => {
    expect(itemSlug(item({ title: 'Škoda Octávia' }))).toBe('skoda-octavia')
  })

  it('collapses separator runs and trims the edges', () => {
    expect(itemSlug(item({ title: 'JCB 3 CX / 2007' }))).toBe('jcb-3-cx-2007')
  })

  it('returns empty for a non-Latin title (graceful fallback to bare /item/<id>)', () => {
    expect(itemSlug(item({ title: 'Транспорт' }))).toBe('')
  })

  it('returns empty for a missing title', () => {
    expect(itemSlug(item({ title: '' }))).toBe('')
  })

  it('caps length at 80 chars with no trailing hyphen', () => {
    const slug = itemSlug(item({ title: 'a '.repeat(100) }))
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('itemPath', () => {
  it('builds /item/<id>/<slug> when a slug exists', () => {
    expect(itemPath(item({ id: 'abc', title: 'BMW X5' }))).toBe('/item/abc/bmw-x5')
  })

  it('falls back to /item/<id> when the slug would be empty', () => {
    expect(itemPath(item({ id: 'abc', title: 'Транспорт' }))).toBe('/item/abc')
  })
})
