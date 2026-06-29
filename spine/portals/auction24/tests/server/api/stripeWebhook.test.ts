import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/webhooks/stripe.post'
import { parseDepositCheckoutSession } from '~/server/utils/stripe'
import { finalizeDepositSettlement, sendDepositPaidEmail } from '~/server/utils/deposit'
import { captureServerError } from '~/server/utils/observability'
import { claimStripeEvent, processStripeDeposit } from '~/server/repos/depositRepo'

const constructEvent = vi.fn()
vi.mock('~/server/utils/stripe', () => ({
  getStripe: () => ({ webhooks: { constructEvent } }),
  parseDepositCheckoutSession: vi.fn(),
}))
vi.mock('~/server/utils/deposit', () => ({ finalizeDepositSettlement: vi.fn(), sendDepositPaidEmail: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))
vi.mock('~/server/repos/depositRepo', () => ({ claimStripeEvent: vi.fn(), processStripeDeposit: vi.fn() }))

const g = globalThis as Record<string, unknown>

const completedEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt_1',
  type: 'checkout.session.completed',
  created: 1_700_000_000,
  data: { object: { id: 'cs_1' } },
  ...overrides,
})

const call = (body: unknown = { any: true }, signature = 'sig') =>
  handler(makeEvent({ body, headers: signature ? { 'stripe-signature': signature } : {} }) as never)

beforeEach(() => {
  vi.clearAllMocks()
  g.useRuntimeConfig = () => ({ stripeWebhookSecret: 'whsec', stripeSecretKey: 'sk' })
  constructEvent.mockReturnValue(completedEvent())
  vi.mocked(parseDepositCheckoutSession).mockReturnValue({
    ok: true,
    data: { userId: 'u1', invoiceId: 'inv1', currency: 'CZK', amount: 10000, sessionId: 'cs_1', paymentIntent: 'pi_1' },
  } as never)
})

describe('POST /api/webhooks/stripe — auth', () => {
  it('401s when not configured', async () => {
    g.useRuntimeConfig = () => ({})
    await expect(call()).rejects.toMatchObject({ statusCode: 401 })
  })
  it('400s on empty body', async () => {
    await expect(handler(makeEvent({ headers: { 'stripe-signature': 'sig' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })
  it('401s without a signature header', async () => {
    await expect(call({ a: 1 }, '')).rejects.toMatchObject({ statusCode: 401 })
  })
  it('401s and reports when signature verification throws', async () => {
    constructEvent.mockImplementation(() => {
      throw new Error('bad sig')
    })
    await expect(call()).rejects.toMatchObject({ statusCode: 401 })
    expect(captureServerError).toHaveBeenCalled()
  })
})

describe('POST /api/webhooks/stripe — processing', () => {
  it('ignores non-completed events but claims them', async () => {
    constructEvent.mockReturnValue(completedEvent({ type: 'payment_intent.created' }))
    expect(await call()).toEqual({ received: true, processed: false, reason: 'ignored' })
    expect(claimStripeEvent).toHaveBeenCalledWith('evt_1', 'payment_intent.created')
    expect(processStripeDeposit).not.toHaveBeenCalled()
  })

  it('claims a foreign (not_deposit) session without reporting', async () => {
    vi.mocked(parseDepositCheckoutSession).mockReturnValue({ ok: false, reason: 'not_deposit' } as never)
    expect((await call()).reason).toBe('not_deposit')
    expect(claimStripeEvent).toHaveBeenCalled()
    expect(captureServerError).not.toHaveBeenCalled()
  })

  it('reports a malformed deposit session', async () => {
    vi.mocked(parseDepositCheckoutSession).mockReturnValue({ ok: false, reason: 'invalid_amount' } as never)
    expect((await call()).reason).toBe('invalid_amount')
    expect(captureServerError).toHaveBeenCalled()
  })

  it.each([
    ['duplicate', 'duplicate_event'],
    ['already_settled', 'already_settled'],
  ])('maps the %s outcome', async (outcome, reason) => {
    vi.mocked(processStripeDeposit).mockResolvedValue({ outcome } as never)
    expect(await call()).toEqual({ received: true, processed: false, reason })
  })

  it('flags an unmatched payment as a refund candidate', async () => {
    vi.mocked(processStripeDeposit).mockResolvedValue({ outcome: 'unmatched' } as never)
    expect((await call()).reason).toBe('unmatched_refund_candidate')
    expect(captureServerError).toHaveBeenCalled()
  })

  it('finalizes and emails on a settled deposit', async () => {
    vi.mocked(processStripeDeposit).mockResolvedValue({ outcome: 'settled', settled: { invoiceId: 'inv1' } } as never)
    expect(await call()).toEqual({ received: true, processed: true })
    expect(finalizeDepositSettlement).toHaveBeenCalledWith({ invoiceId: 'inv1' })
    expect(sendDepositPaidEmail).toHaveBeenCalledWith({ invoiceId: 'inv1' })
  })
})
