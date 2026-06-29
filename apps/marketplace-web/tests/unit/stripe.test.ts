import { describe, it, expect } from 'vitest'
import Stripe from 'stripe'
import { parseDepositCheckoutSession, toStripeUnit } from '~/server/utils/stripe'

const validSession = {
  id: 'cs_test_123',
  payment_status: 'paid',
  amount_total: 1000000,
  currency: 'czk',
  payment_intent: 'pi_123',
  metadata: {
    type: 'deposit',
    userId: 'firebase-uid-007',
    invoiceId: '7e64a6a1-7d70-4f5e-9c39-1f6e9a3b2c4d',
    currency: 'CZK',
  },
}

describe('toStripeUnit', () => {
  it('converts major units to integer minor units', () => {
    expect(toStripeUnit(10000)).toBe(1000000)
    expect(toStripeUnit(500)).toBe(50000)
    expect(toStripeUnit(99.995)).toBe(10000)
  })
})

describe('parseDepositCheckoutSession', () => {
  it('parses a valid deposit session', () => {
    const parsed = parseDepositCheckoutSession(validSession)
    expect(parsed).toEqual({
      ok: true,
      data: {
        userId: 'firebase-uid-007',
        invoiceId: '7e64a6a1-7d70-4f5e-9c39-1f6e9a3b2c4d',
        currency: 'CZK',
        amount: 10000,
        sessionId: 'cs_test_123',
        paymentIntent: 'pi_123',
      },
    })
  })

  it('accepts an expanded payment_intent object and a Firebase-style userId', () => {
    const parsed = parseDepositCheckoutSession({
      ...validSession,
      payment_intent: { id: 'pi_expanded' },
      metadata: { ...validSession.metadata, userId: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4' },
    })
    expect(parsed.ok && parsed.data.paymentIntent).toBe('pi_expanded')
    expect(parsed.ok && parsed.data.userId).toBe('A1b2C3d4E5f6G7h8I9j0K1l2M3n4')
  })

  it('nulls a malformed invoiceId instead of rejecting (webhook falls back by user+currency)', () => {
    const parsed = parseDepositCheckoutSession({
      ...validSession,
      metadata: { ...validSession.metadata, invoiceId: 'not-a-uuid' },
    })
    expect(parsed.ok && parsed.data.invoiceId).toBeNull()
  })

  it('rejects foreign, unpaid, and malformed sessions with stable reasons', () => {
    const reject = (over: Record<string, unknown>) => {
      const parsed = parseDepositCheckoutSession({ ...validSession, ...over })
      return parsed.ok ? 'ok' : parsed.reason
    }
    expect(reject({ metadata: { type: 'subscription' } })).toBe('not_deposit')
    expect(reject({ metadata: null })).toBe('not_deposit')
    expect(reject({ payment_status: 'unpaid' })).toBe('not_paid')
    expect(reject({ id: undefined })).toBe('missing_session_id')
    expect(reject({ metadata: { type: 'deposit', userId: '  ' } })).toBe('invalid_user_id')
    expect(reject({ currency: 'usd' })).toBe('invalid_currency')
    expect(reject({ amount_total: null })).toBe('invalid_amount')
    expect(reject({ amount_total: -5 })).toBe('invalid_amount')
  })
})

describe('stripe webhook signature round-trip', () => {
  const stripe = new Stripe('sk_test_dummy')
  const secret = 'whsec_unit_test_secret'
  const payload = JSON.stringify({ id: 'evt_unit_1', object: 'event', type: 'checkout.session.completed' })

  it('accepts a payload signed with the endpoint secret', () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret })
    const event = stripe.webhooks.constructEvent(payload, header, secret)
    expect(event.id).toBe('evt_unit_1')
  })

  it('rejects a tampered payload and a wrong secret', () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret })
    expect(() => stripe.webhooks.constructEvent(payload.replace('evt_unit_1', 'evt_evil'), header, secret)).toThrow()
    expect(() => stripe.webhooks.constructEvent(payload, header, 'whsec_other')).toThrow()
  })
})
