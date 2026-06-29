import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/deposit/checkout.post'
import { requireSession } from '~/server/utils/session'
import { ensureOpenDepositInvoice, expireStripeSessions } from '~/server/utils/deposit'
import { isStripeConfigured } from '~/server/utils/stripe'
import { setInvoiceStripeSession } from '~/server/repos/depositRepo'

vi.mock('~/server/utils/session', () => ({ requireSession: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/deposit', () => ({ ensureOpenDepositInvoice: vi.fn(), expireStripeSessions: vi.fn() }))
vi.mock('~/server/repos/depositRepo', () => ({ setInvoiceStripeSession: vi.fn() }))

const sessionsCreate = vi.fn()
vi.mock('~/server/utils/stripe', () => ({
  getStripe: () => ({ checkout: { sessions: { create: sessionsCreate } } }),
  isStripeConfigured: vi.fn(() => true),
  toStripeUnit: (n: number) => Math.round(n * 100),
}))

// Mock the Stripe SDK so getStripe() in the real util module instantiates a
// deterministic stub instead of a real client (no network, no key validation).
const stripeCtor = vi.fn()
vi.mock('stripe', () => ({
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Stripe SDK mock must be constructable (new Stripe())
  default: class {
    constructor(key: string) {
      stripeCtor(key)
    }
  },
}))

const g = globalThis as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireSession).mockResolvedValue({ id: 'u1', email: 'u@x.cz' } as never)
  vi.mocked(isStripeConfigured).mockReturnValue(true)
  g.useRuntimeConfig = () => ({ public: { stripeEnabled: true, baseUrl: 'https://app.test' } })
  vi.mocked(ensureOpenDepositInvoice).mockResolvedValue({
    invoice: { id: 'inv1', priceAmount: '10000', stripeSessionId: null },
  } as never)
  sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://pay.stripe/cs_1' })
})

describe('POST /api/deposit/checkout', () => {
  it('creates a Stripe session and returns its url', async () => {
    const res = await handler(makeEvent({ body: { currency: 'CZK' } }) as never)
    expect(res).toEqual({ url: 'https://pay.stripe/cs_1' })
    expect(setInvoiceStripeSession).toHaveBeenCalledWith('inv1', 'cs_1')
    const [params, opts] = sessionsCreate.mock.calls[0]!
    expect(params.metadata).toMatchObject({ type: 'deposit', userId: 'u1', invoiceId: 'inv1', currency: 'CZK' })
    expect(opts.idempotencyKey).toMatch(/^deposit-inv1-\d+$/)
  })

  it('expires a superseded session before overwriting it', async () => {
    vi.mocked(ensureOpenDepositInvoice).mockResolvedValue({
      invoice: { id: 'inv1', priceAmount: '10000', stripeSessionId: 'cs_old' },
    } as never)
    await handler(makeEvent({ body: { currency: 'CZK' } }) as never)
    expect(expireStripeSessions).toHaveBeenCalledWith(['cs_old'])
  })

  it('503s when card payments are disabled by flag', async () => {
    g.useRuntimeConfig = () => ({ public: { stripeEnabled: false } })
    await expect(handler(makeEvent({ body: { currency: 'CZK' } }) as never)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('503s when Stripe is not configured', async () => {
    vi.mocked(isStripeConfigured).mockReturnValue(false)
    await expect(handler(makeEvent({ body: { currency: 'CZK' } }) as never)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('400s on an invalid currency', async () => {
    await expect(handler(makeEvent({ body: { currency: 'USD' } }) as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('502s when Stripe returns no url', async () => {
    sessionsCreate.mockResolvedValue({ id: 'cs_1', url: null })
    await expect(handler(makeEvent({ body: { currency: 'EUR' } }) as never)).rejects.toMatchObject({ statusCode: 502 })
  })

  it('falls back to depositAmountFor when invoice has no priceAmount', async () => {
    vi.mocked(ensureOpenDepositInvoice).mockResolvedValue({
      invoice: { id: 'inv1', priceAmount: null, stripeSessionId: null },
    } as never)
    await handler(makeEvent({ body: { currency: 'EUR' } }) as never)
    const [params] = sessionsCreate.mock.calls[0]!
    expect(params.line_items[0].price_data.unit_amount).toBe(50000) // 500 EUR * 100
  })

  it('uses the request origin as base when baseUrl is empty', async () => {
    g.useRuntimeConfig = () => ({ public: { stripeEnabled: true, baseUrl: '' } })
    await handler(makeEvent({ body: { currency: 'CZK' }, url: 'https://origin.test/api/x' }) as never)
    const [params] = sessionsCreate.mock.calls[0]!
    expect(params.success_url).toBe('https://origin.test/profile/billing?deposit=success')
    expect(params.cancel_url).toBe('https://origin.test/profile/billing?deposit=cancelled')
  })

  it('does not expire the existing session when it matches the new one', async () => {
    vi.mocked(ensureOpenDepositInvoice).mockResolvedValue({
      invoice: { id: 'inv1', priceAmount: '10000', stripeSessionId: 'cs_1' },
    } as never)
    sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://pay.stripe/cs_1' })
    await handler(makeEvent({ body: { currency: 'CZK' } }) as never)
    expect(expireStripeSessions).not.toHaveBeenCalled()
  })

  it('400s when the body cannot be parsed (currency undefined)', async () => {
    // makeEvent with no body → readBody returns undefined → currency undefined → invalid
    await expect(handler(makeEvent({}) as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s when readBody rejects (catch fallback → currency undefined)', async () => {
    // A throwing context.body getter makes the harness readBody reject; the
    // handler's .catch(() => undefined) yields no body → undefined currency.
    const event = makeEvent({})
    Object.defineProperty((event as { context: object }).context, 'body', {
      get() {
        throw new Error('unparseable body')
      },
    })
    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('builds a 30-min-safe expires_at two hour-buckets ahead', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-19T10:30:00Z'))
    try {
      await handler(makeEvent({ body: { currency: 'CZK' } }) as never)
      const [params] = sessionsCreate.mock.calls[0]!
      const hourBucket = Math.floor(Date.now() / 3_600_000)
      expect(params.expires_at).toBe((hourBucket + 2) * 3600)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Direct coverage of the real stripe util module (the handler tests above mock it).
// Imported via importActual so the file-level vi.mock('~/server/utils/stripe') is bypassed.
type StripeModule = typeof import('~/server/utils/stripe')

describe('server/utils/stripe', () => {
  let mod: StripeModule

  const loadActual = async (): Promise<StripeModule> => (await vi.importActual('~/server/utils/stripe')) as StripeModule

  beforeEach(async () => {
    mod = await loadActual()
  })

  afterEach(() => {
    g.useRuntimeConfig = () => ({ public: {} })
  })

  describe('isStripeConfigured', () => {
    it('is true when a secret key is present', () => {
      g.useRuntimeConfig = () => ({ stripeSecretKey: 'sk_test_123', public: {} })
      expect(mod.isStripeConfigured()).toBe(true)
    })

    it('is false when the secret key is empty', () => {
      g.useRuntimeConfig = () => ({ stripeSecretKey: '', public: {} })
      expect(mod.isStripeConfigured()).toBe(false)
    })
  })

  describe('getStripe', () => {
    it('throws when no secret key is configured', () => {
      g.useRuntimeConfig = () => ({ stripeSecretKey: '', public: {} })
      expect(() => mod.getStripe()).toThrow('Stripe not configured')
    })

    it('instantiates once and caches the client', () => {
      stripeCtor.mockClear()
      g.useRuntimeConfig = () => ({ stripeSecretKey: 'sk_test_abc', public: {} })
      const first = mod.getStripe()
      const second = mod.getStripe()
      expect(first).toBe(second)
      expect(stripeCtor).toHaveBeenCalledTimes(1)
      expect(stripeCtor).toHaveBeenCalledWith('sk_test_abc')
    })
  })

  describe('toStripeUnit', () => {
    it('converts major units to integer minor units', () => {
      expect(mod.toStripeUnit(500)).toBe(50000)
      expect(mod.toStripeUnit(10000)).toBe(1_000_000)
    })

    it('rounds fractional amounts', () => {
      expect(mod.toStripeUnit(12.349)).toBe(1235)
    })
  })

  describe('parseDepositCheckoutSession', () => {
    const okSession = (over: Record<string, unknown> = {}) => ({
      id: 'cs_live_1',
      payment_status: 'paid',
      amount_total: 50000,
      currency: 'eur',
      payment_intent: 'pi_1',
      metadata: { type: 'deposit', userId: 'u1', invoiceId: '11111111-2222-4333-8444-555555555555' },
      ...over,
    })

    it('parses a complete valid session', () => {
      const res = mod.parseDepositCheckoutSession(okSession())
      expect(res).toEqual({
        ok: true,
        data: {
          userId: 'u1',
          invoiceId: '11111111-2222-4333-8444-555555555555',
          currency: 'EUR',
          amount: 500,
          sessionId: 'cs_live_1',
          paymentIntent: 'pi_1',
        },
      })
    })

    it('rejects a non-deposit session', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ metadata: { type: 'order' } }))
      expect(res).toEqual({ ok: false, reason: 'not_deposit' })
    })

    it('rejects a session with null/missing metadata', () => {
      const res = mod.parseDepositCheckoutSession({ payment_status: 'paid' })
      expect(res).toEqual({ ok: false, reason: 'not_deposit' })
    })

    it('rejects an unpaid session', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ payment_status: 'unpaid' }))
      expect(res).toEqual({ ok: false, reason: 'not_paid' })
    })

    it('rejects a session missing its id', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ id: undefined }))
      expect(res).toEqual({ ok: false, reason: 'missing_session_id' })
    })

    it('rejects a non-string id', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ id: 123 }))
      expect(res).toEqual({ ok: false, reason: 'missing_session_id' })
    })

    it('rejects a session with an empty/whitespace userId', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ metadata: { type: 'deposit', userId: '   ' } }))
      expect(res).toEqual({ ok: false, reason: 'invalid_user_id' })
    })

    it('rejects a session with a non-string userId', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ metadata: { type: 'deposit', userId: 42 } }))
      expect(res).toEqual({ ok: false, reason: 'invalid_user_id' })
    })

    it('trims the userId', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ metadata: { type: 'deposit', userId: '  u9  ' } }))
      expect(res).toMatchObject({ ok: true, data: { userId: 'u9', invoiceId: null } })
    })

    it('nulls a non-UUID invoiceId', () => {
      const res = mod.parseDepositCheckoutSession(
        okSession({ metadata: { type: 'deposit', userId: 'u1', invoiceId: 'not-a-uuid' } }),
      )
      expect(res).toMatchObject({ ok: true, data: { invoiceId: null } })
    })

    it('nulls a missing (non-string) invoiceId', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ metadata: { type: 'deposit', userId: 'u1' } }))
      expect(res).toMatchObject({ ok: true, data: { invoiceId: null } })
    })

    it('rejects an unsupported currency', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ currency: 'usd' }))
      expect(res).toEqual({ ok: false, reason: 'invalid_currency' })
    })

    it('rejects a non-string currency', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ currency: null }))
      expect(res).toEqual({ ok: false, reason: 'invalid_currency' })
    })

    it('rejects a non-number amount_total', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ amount_total: '50000' }))
      expect(res).toEqual({ ok: false, reason: 'invalid_amount' })
    })

    it('rejects a non-finite amount_total', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ amount_total: Number.POSITIVE_INFINITY }))
      expect(res).toEqual({ ok: false, reason: 'invalid_amount' })
    })

    it('rejects a non-positive amount_total', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ amount_total: 0 }))
      expect(res).toEqual({ ok: false, reason: 'invalid_amount' })
    })

    it('reads payment_intent from an expanded object', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ payment_intent: { id: 'pi_obj' } }))
      expect(res).toMatchObject({ ok: true, data: { paymentIntent: 'pi_obj' } })
    })

    it('nulls payment_intent when absent', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ payment_intent: null }))
      expect(res).toMatchObject({ ok: true, data: { paymentIntent: null } })
    })

    it('nulls payment_intent when the object has no id', () => {
      const res = mod.parseDepositCheckoutSession(okSession({ payment_intent: {} }))
      expect(res).toMatchObject({ ok: true, data: { paymentIntent: null } })
    })
  })
})
