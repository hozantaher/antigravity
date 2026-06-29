import { describe, it, expect } from 'vitest'
import { computeAmountDue, depositCreditApplied, settlementStateFrom, SETTLEMENT_STATE } from '~/models'
import type { Currency, Price } from '~/models'
import { settlementError, type SettlementContext } from '~/server/repos/settlementRepo'

const EUR = { code: 'EUR' } as Currency
const CZK = { code: 'CZK' } as Currency

const price = (amount: number, currency: Currency): Price => ({ amount, currency })

describe('computeAmountDue (I4 — offset only within currency)', () => {
  it('subtracts a same-currency deposit from the final price', () => {
    expect(computeAmountDue(price(32000, EUR), price(500, EUR))).toEqual({ amount: 31500, currency: EUR })
  })

  it('returns 0 (not negative) when the deposit exceeds the price', () => {
    // Residual is NOT refunded here (v1 cut) — capped at 0.
    expect(computeAmountDue(price(400, EUR), price(500, EUR))).toEqual({ amount: 0, currency: EUR })
  })

  it('returns 0 when the deposit exactly covers the price', () => {
    expect(computeAmountDue(price(500, EUR), price(500, EUR))).toEqual({ amount: 0, currency: EUR })
  })

  it('does NOT offset across currencies — winner owes the full price', () => {
    // A CZK deposit must never be silently converted to offset a EUR price.
    expect(computeAmountDue(price(32000, EUR), price(10000, CZK))).toEqual({ amount: 32000, currency: EUR })
  })

  it('does not offset when there is no deposit', () => {
    expect(computeAmountDue(price(32000, EUR), undefined)).toEqual({ amount: 32000, currency: EUR })
  })

  it('uses integer cents so sub-cent floats do not drift', () => {
    expect(computeAmountDue(price(100.1, EUR), price(0.05, EUR)).amount).toBe(100.05)
  })

  it('ignores a zero-amount deposit', () => {
    expect(computeAmountDue(price(32000, EUR), price(0, EUR))).toEqual({ amount: 32000, currency: EUR })
  })
})

describe('depositCreditApplied', () => {
  it('reports the credit actually offset (same currency)', () => {
    expect(depositCreditApplied(price(32000, EUR), price(500, EUR))).toEqual({ amount: 500, currency: EUR })
  })

  it('caps the credit at the price (no over-credit beyond what is owed)', () => {
    expect(depositCreditApplied(price(400, EUR), price(500, EUR))).toEqual({ amount: 400, currency: EUR })
  })

  it('reports zero credit across currencies', () => {
    expect(depositCreditApplied(price(32000, EUR), price(10000, CZK))).toEqual({ amount: 0, currency: EUR })
  })
})

describe('settlementStateFrom (derive, not store)', () => {
  it('due when no invoice exists', () => {
    expect(settlementStateFrom(undefined, false)).toBe(SETTLEMENT_STATE.due)
    expect(settlementStateFrom(null, false)).toBe(SETTLEMENT_STATE.due)
  })
  it('due when the invoice was canceled', () => {
    expect(settlementStateFrom('canceled', false)).toBe(SETTLEMENT_STATE.due)
  })
  it('pending while the invoice is unpaid', () => {
    expect(settlementStateFrom('unpaid', false)).toBe(SETTLEMENT_STATE.pending)
  })
  it('paid when the invoice is paid but not yet completion-stamped', () => {
    expect(settlementStateFrom('paid', false)).toBe(SETTLEMENT_STATE.paid)
  })
  it('completed when paid AND completion-stamped (terminal)', () => {
    expect(settlementStateFrom('paid', true)).toBe(SETTLEMENT_STATE.completed)
  })
})

describe('settlementError (winner/sold/already-settled gate)', () => {
  const base: SettlementContext = { userId: 'u1', sold: true, closed: true, winnerId: 'u1', alreadyCompleted: false }

  it('passes for the winner of a sold+closed unsettled item', () => {
    expect(settlementError(base)).toBeNull()
  })
  it('404 when the item is not sold', () => {
    expect(settlementError({ ...base, sold: false })).toEqual({ status: 404, code: 'not_sold' })
  })
  it('404 when the auction is not closed', () => {
    expect(settlementError({ ...base, closed: false })).toEqual({ status: 404, code: 'not_sold' })
  })
  it('404 when there is no winner', () => {
    expect(settlementError({ ...base, winnerId: null })).toEqual({ status: 404, code: 'not_sold' })
  })
  it('403 when the viewer is not the winner', () => {
    expect(settlementError({ ...base, userId: 'someone-else' })).toEqual({ status: 403, code: 'not_winner' })
  })
  it('409 when the sale is already settled', () => {
    expect(settlementError({ ...base, alreadyCompleted: true })).toEqual({ status: 409, code: 'already_settled' })
  })
})
