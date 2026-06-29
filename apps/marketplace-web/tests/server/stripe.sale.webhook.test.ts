import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../setup/server'

import handler from '~/server/api/webhooks/stripe.post'
import { parseSaleCheckoutSession } from '~/server/utils/stripe'
import { finalizeSaleSettlement, sendSalePaidEmail } from '~/server/utils/settlement'
import { finalizeDepositSettlement, sendDepositPaidEmail } from '~/server/utils/deposit'
import { captureServerError } from '~/server/utils/observability'
import { claimStripeEvent, processStripeDeposit } from '~/server/repos/depositRepo'
import { markSaleCompleted, processStripeSale } from '~/server/repos/settlementRepo'

const constructEvent = vi.fn()
vi.mock('~/server/utils/stripe', () => ({
  getStripe: () => ({ webhooks: { constructEvent } }),
  parseDepositCheckoutSession: vi.fn(),
  parseSaleCheckoutSession: vi.fn(),
}))
vi.mock('~/server/utils/settlement', () => ({ finalizeSaleSettlement: vi.fn(), sendSalePaidEmail: vi.fn() }))
vi.mock('~/server/utils/deposit', () => ({ finalizeDepositSettlement: vi.fn(), sendDepositPaidEmail: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))
vi.mock('~/server/repos/depositRepo', () => ({ claimStripeEvent: vi.fn(), processStripeDeposit: vi.fn() }))
vi.mock('~/server/repos/settlementRepo', () => ({ markSaleCompleted: vi.fn(), processStripeSale: vi.fn() }))

const g = globalThis as Record<string, unknown>

const saleEvent = (sessionOver: Record<string, unknown> = {}) => ({
  id: 'evt_sale_1',
  type: 'checkout.session.completed',
  created: 1_700_000_000,
  data: { object: { id: 'cs_sale_1', metadata: { type: 'sale' }, ...sessionOver } },
})

const call = (signature = 'sig') =>
  handler(makeEvent({ body: { any: true }, headers: signature ? { 'stripe-signature': signature } : {} }) as never)

const saleData = {
  userId: 'u1',
  itemId: 'i1',
  invoiceId: '11111111-1111-1111-1111-111111111111',
  currency: 'EUR',
  amount: 31500,
  sessionId: 'cs_sale_1',
  paymentIntent: 'pi_sale_1',
}

beforeEach(() => {
  vi.clearAllMocks()
  g.useRuntimeConfig = () => ({ stripeWebhookSecret: 'whsec', stripeSecretKey: 'sk' })
  constructEvent.mockReturnValue(saleEvent())
  vi.mocked(parseSaleCheckoutSession).mockReturnValue({ ok: true, data: saleData } as never)
})

describe('Stripe webhook — sale branch routing', () => {
  it('routes a metadata.type==="sale" session to processStripeSale (not the deposit path)', async () => {
    vi.mocked(processStripeSale).mockResolvedValue({
      outcome: 'settled',
      settled: { invoiceId: saleData.invoiceId, itemId: 'i1', paidOn: new Date(), amount: 31500 },
    } as never)
    const res = await call()
    expect(res).toEqual({ received: true, processed: true })
    expect(processStripeSale).toHaveBeenCalledOnce()
    // The deposit path must NOT run for a sale event.
    expect(processStripeDeposit).not.toHaveBeenCalled()
    // Completion stamp + finalize + email fire on a real settle.
    expect(markSaleCompleted).toHaveBeenCalledWith('i1', expect.any(Date))
    expect(finalizeSaleSettlement).toHaveBeenCalledOnce()
    expect(sendSalePaidEmail).toHaveBeenCalledOnce()
    expect(finalizeDepositSettlement).not.toHaveBeenCalled()
    expect(sendDepositPaidEmail).not.toHaveBeenCalled()
  })

  it('401s (fail-closed) when the signature does not verify', async () => {
    constructEvent.mockImplementation(() => {
      throw new Error('bad sig')
    })
    await expect(call()).rejects.toMatchObject({ statusCode: 401 })
    expect(processStripeSale).not.toHaveBeenCalled()
  })

  it('401s when the stripe-signature header is missing', async () => {
    await expect(call('')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('a duplicate (replayed) event is a no-op', async () => {
    vi.mocked(processStripeSale).mockResolvedValue({ outcome: 'duplicate' } as never)
    const res = await call()
    expect(res).toMatchObject({ processed: false, reason: 'duplicate_event' })
    expect(finalizeSaleSettlement).not.toHaveBeenCalled()
  })

  it('a cross-rail replay (already settled by Fio) is recognized, not double-charged', async () => {
    vi.mocked(processStripeSale).mockResolvedValue({ outcome: 'already_settled' } as never)
    const res = await call()
    expect(res).toMatchObject({ processed: false, reason: 'already_settled' })
    expect(markSaleCompleted).not.toHaveBeenCalled()
  })

  it('an unmatched sale payment is logged as a refund candidate, never silently accepted', async () => {
    vi.mocked(processStripeSale).mockResolvedValue({ outcome: 'unmatched' } as never)
    const res = await call()
    expect(res).toMatchObject({ processed: false, reason: 'unmatched_refund_candidate' })
    expect(captureServerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('refund candidate') }),
      expect.objectContaining({ area: 'stripe.webhook.sale' }),
    )
  })

  it('a malformed sale session is claimed (so redeliveries stop) and logged', async () => {
    vi.mocked(parseSaleCheckoutSession).mockReturnValue({ ok: false, reason: 'invalid_invoice_id' } as never)
    const res = await call()
    expect(res).toMatchObject({ processed: false, reason: 'invalid_invoice_id' })
    expect(claimStripeEvent).toHaveBeenCalledWith('evt_sale_1', 'checkout.session.completed')
    expect(processStripeSale).not.toHaveBeenCalled()
  })

  it('settles even when the metadata has no itemId — no completion stamp then, but money lands', async () => {
    vi.mocked(processStripeSale).mockResolvedValue({
      outcome: 'settled',
      settled: { invoiceId: saleData.invoiceId, itemId: null, paidOn: new Date(), amount: 31500 },
    } as never)
    const res = await call()
    expect(res).toEqual({ received: true, processed: true })
    expect(markSaleCompleted).not.toHaveBeenCalled()
    expect(finalizeSaleSettlement).toHaveBeenCalledOnce()
  })
})
