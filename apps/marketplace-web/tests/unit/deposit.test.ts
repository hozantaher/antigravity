import { describe, it, expect } from 'vitest'
import { DEPOSIT_AMOUNTS, depositAmountFor, hasDepositPaid, isDepositCurrency } from '~/models'

describe('deposit model', () => {
  it('has the fixed unified amounts', () => {
    expect(DEPOSIT_AMOUNTS.CZK).toBe(10000)
    expect(DEPOSIT_AMOUNTS.EUR).toBe(500)
    expect(depositAmountFor('CZK')).toBe(10000)
    expect(depositAmountFor('EUR')).toBe(500)
  })

  it('guards the currency union', () => {
    expect(isDepositCurrency('CZK')).toBe(true)
    expect(isDepositCurrency('EUR')).toBe(true)
    expect(isDepositCurrency('USD')).toBe(false)
    expect(isDepositCurrency(undefined)).toBe(false)
    expect(isDepositCurrency(10000)).toBe(false)
  })

  it('hasDepositPaid: exempt OR positive balance', () => {
    expect(hasDepositPaid({ depositRequired: false, depositBalance: { amount: 0 } })).toBe(true)
    expect(hasDepositPaid({ depositRequired: true, depositBalance: { amount: 10000 } })).toBe(true)
    expect(hasDepositPaid({ depositRequired: true, depositBalance: { amount: 0 } })).toBe(false)
    expect(hasDepositPaid({ depositRequired: true, depositBalance: { amount: undefined } })).toBe(false)
  })
})
