import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/item/[id]/settlement/checkout.post'
import { requireSession } from '~/server/utils/session'
import { prepareSaleCheckout, expireSaleStripeSessions } from '~/server/utils/settlement'
import { findSettlementCandidate, setSaleInvoiceStripeSession } from '~/server/repos/settlementRepo'
import { getStripe, isStripeConfigured } from '~/server/utils/stripe'

vi.mock('~/server/utils/session', () => ({ requireSession: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/settlement', () => ({ prepareSaleCheckout: vi.fn(), expireSaleStripeSessions: vi.fn() }))
vi.mock('~/server/utils/stripe', () => ({
  getStripe: vi.fn(),
  isStripeConfigured: vi.fn(() => true),
  toStripeUnit: (n: number) => Math.round(n * 100),
}))
vi.mock('~/server/repos/settlementRepo', async orig => {
  const actual = await orig<typeof import('~/server/repos/settlementRepo')>()
  return { ...actual, findSettlementCandidate: vi.fn(), setSaleInvoiceStripeSession: vi.fn() }
})

const g = globalThis as Record<string, unknown>

const candidate = (over: Record<string, unknown> = {}) => ({
  itemId: 'i1',
  sold: true,
  closed: true,
  winnerId: 'u1',
  settledAt: null,
  settlementInvoiceId: null,
  invoice: undefined,
  ...over,
})

const sessionsCreate = vi.fn()
const event = () => makeEvent({ params: { id: 'i1' } })

beforeEach(() => {
  vi.clearAllMocks()
  g.useRuntimeConfig = () => ({ public: { stripeEnabled: true, baseUrl: 'https://app.test' } })
  vi.mocked(requireSession).mockResolvedValue({ id: 'u1', email: 'u1@x.cz' } as never)
  vi.mocked(isStripeConfigured).mockReturnValue(true)
  vi.mocked(findSettlementCandidate).mockResolvedValue(candidate() as never)
  vi.mocked(prepareSaleCheckout).mockResolvedValue({
    invoice: { id: 'inv-sale-1', stripeSessionId: null },
    amountDue: 31500,
    currency: 'EUR',
  } as never)
  sessionsCreate.mockResolvedValue({ id: 'cs_sale_1', url: 'https://stripe/pay' })
  vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { create: sessionsCreate } } } as never)
})

describe('POST /api/item/:id/settlement/checkout', () => {
  it('creates a Stripe session for the amount due and returns the URL', async () => {
    const res = await handler(event() as never)
    expect(res).toEqual({ url: 'https://stripe/pay' })

    const [params, opts] = sessionsCreate.mock.calls[0]!
    // Amount due passed to Stripe in minor units.
    expect(params.line_items[0].price_data.unit_amount).toBe(3_150_000)
    expect(params.line_items[0].price_data.currency).toBe('eur')
    // Metadata routes the webhook to the sale branch + binds item/invoice.
    expect(params.metadata).toMatchObject({ type: 'sale', userId: 'u1', invoiceId: 'inv-sale-1', itemId: 'i1' })
    // Idempotency key carries the invoice id (a re-call with the same hour bucket is safe).
    expect(opts.idempotencyKey).toMatch(/^sale-inv-sale-1-\d+$/)
    expect(setSaleInvoiceStripeSession).toHaveBeenCalledWith('inv-sale-1', 'cs_sale_1')
  })

  it('expires a superseded prior session before overwriting it', async () => {
    vi.mocked(prepareSaleCheckout).mockResolvedValue({
      invoice: { id: 'inv-sale-1', stripeSessionId: 'cs_old' },
      amountDue: 31500,
      currency: 'EUR',
    } as never)
    await handler(event() as never)
    expect(expireSaleStripeSessions).toHaveBeenCalledWith(['cs_old'])
  })

  it('503 when card payments are disabled by flag', async () => {
    g.useRuntimeConfig = () => ({ public: { stripeEnabled: false } })
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 503 })
    expect(prepareSaleCheckout).not.toHaveBeenCalled()
  })

  it('503 when Stripe is not configured', async () => {
    vi.mocked(isStripeConfigured).mockReturnValue(false)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('403 for a non-winner', async () => {
    vi.mocked(requireSession).mockResolvedValue({ id: 'intruder', email: 'x@x.cz' } as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(prepareSaleCheckout).not.toHaveBeenCalled()
  })

  it('409 when already paid', async () => {
    vi.mocked(findSettlementCandidate).mockResolvedValue(candidate({ invoice: { status: 'paid' } }) as never)
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('502 when Stripe returns no URL', async () => {
    sessionsCreate.mockResolvedValue({ id: 'cs_sale_1', url: null })
    await expect(handler(event() as never)).rejects.toMatchObject({ statusCode: 502 })
  })
})
