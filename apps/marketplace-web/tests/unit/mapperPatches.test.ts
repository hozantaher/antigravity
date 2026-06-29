import { describe, expect, it } from 'vitest'
import { ItemType } from '~/models'
import { itemPatchToUpdate, userProfilePatchToUpdate } from '~/server/repos/mappers'

describe('itemPatchToUpdate', () => {
  it('maps only the keys present on the patch', () => {
    expect(itemPatchToUpdate({ hidden: true })).toEqual({ hidden: true })
    expect(itemPatchToUpdate({})).toEqual({})
  })

  it('splits price objects into amount + currency columns', () => {
    expect(itemPatchToUpdate({ minimalPrice: { amount: 100, currency: { code: 'EUR' } } as never })).toMatchObject({
      minimalPriceAmount: 100,
      minimalPriceCurrency: 'EUR',
    })
    // Key present but undefined → explicit null (clears the column).
    expect(itemPatchToUpdate({ priceFrom: undefined })).toEqual({ priceFromAmount: null, priceFromCurrency: null })
  })

  it('stringifies the type enum and converts dates', () => {
    expect(itemPatchToUpdate({ type: ItemType.ad }).type).toBe('ad')
    const startMs = Date.UTC(2025, 0, 1)
    expect(itemPatchToUpdate({ startDate: startMs }).startDate).toEqual(new Date(startMs))
    expect(itemPatchToUpdate({ endDate: undefined }).endDate).toBeNull()
  })

  it('never maps server-owned userId', () => {
    expect('userId' in itemPatchToUpdate({ userId: 'attacker' } as never)).toBe(false)
  })
})

describe('userProfilePatchToUpdate', () => {
  it('maps whitelisted self-editable fields', () => {
    expect(userProfilePatchToUpdate({ fullName: 'Jan', phone: '+420', newsletter: true })).toEqual({
      fullName: 'Jan',
      phone: '+420',
      newsletter: true,
    })
  })

  it('maps language to its code column', () => {
    expect(userProfilePatchToUpdate({ language: { code: 'en' } as never }).languageCode).toBe('en')
  })

  it('drops auth/money/authorization fields a user must not change', () => {
    const u = userProfilePatchToUpdate({ email: 'x@x', roles: ['admin'], banned: true, vat: 1 } as never)
    expect(u).toEqual({})
  })
})
