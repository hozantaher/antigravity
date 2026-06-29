import { describe, it, expect } from 'vitest'
import { itemInputError } from '~/server/repos/itemRepo'
import { ItemType } from '~/models'

describe('itemInputError', () => {
  it('accepts valid categoryId + type', () => {
    expect(itemInputError({ categoryId: 'car', type: ItemType.auction })).toBeNull()
    expect(itemInputError({ categoryId: 'others', type: ItemType.ad })).toBeNull()
  })

  it('accepts input that omits categoryId/type', () => {
    expect(itemInputError({ title: 'x' })).toBeNull()
    expect(itemInputError({})).toBeNull()
  })

  it('rejects an unknown categoryId as 400 (was an opaque 500)', () => {
    const err = itemInputError({ categoryId: 'cars' })
    expect(err?.status).toBe(400)
    expect(err?.message).toContain('cars')
  })

  it('rejects an unknown item type as 400 (no silent coercion)', () => {
    const err = itemInputError({ type: 'zzz' as ItemType })
    expect(err?.status).toBe(400)
    expect(err?.message).toContain('zzz')
  })
})
