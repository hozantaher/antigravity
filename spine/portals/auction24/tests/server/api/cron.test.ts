import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent } from '../../setup/server'

import closeHandler from '~/server/api/cron/close-auctions.post'
import fioHandler from '~/server/api/cron/fio-payments.post'
import { requireCronSecret } from '~/server/utils/session'
import { closeEndedAuctions } from '~/server/utils/auctionCloser'
import { processFioPayments } from '~/server/utils/deposit'

vi.mock('~/server/utils/session', () => ({ requireCronSecret: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/auctionCloser', () => ({ closeEndedAuctions: vi.fn() }))
vi.mock('~/server/utils/deposit', () => ({ processFioPayments: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('cron handlers', () => {
  it('close-auctions delegates after the secret check', async () => {
    vi.mocked(closeEndedAuctions).mockResolvedValue({ closed: 3 } as never)
    expect(await closeHandler(makeEvent() as never)).toEqual({ closed: 3 })
    expect(requireCronSecret).toHaveBeenCalled()
  })

  it('fio-payments delegates after the secret check', async () => {
    vi.mocked(processFioPayments).mockResolvedValue({ matched: 1 } as never)
    expect(await fioHandler(makeEvent() as never)).toEqual({ matched: 1 })
  })

  it('propagates a failed secret check without running the job', async () => {
    vi.mocked(requireCronSecret).mockImplementation(() => {
      throw createError({ statusCode: 401 })
    })
    await expect(closeHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(closeEndedAuctions).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// server/utils/deposit.ts — direct unit coverage. The file mocks the deposit
// module above (for the cron-handler tests), so the real implementation is
// pulled via vi.importActual and all of its IO dependencies are mocked.
// ---------------------------------------------------------------------------

vi.mock('~/server/repos/depositRepo', () => ({
  attachFakturoidDoc: vi.fn(),
  findAnyOpenDepositInvoice: vi.fn(),
  findOpenDepositInvoice: vi.fn(),
  getUserForDeposit: vi.fn(),
  listPaidInvoicesPendingFakturoid: vi.fn(),
  pruneProcessedStripeEvents: vi.fn(),
  recordDepositInvoice: vi.fn(),
  setInvoiceFakturoidPaidAt: vi.fn(),
  setUserFakturoidId: vi.fn(),
  loadProcessedFioIds: vi.fn(),
  settleFioPayment: vi.fn(),
}))

vi.mock('~/server/utils/fakturoid', () => ({
  FakturoidApiError: class FakturoidApiError extends Error {
    readonly status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
  cancelFakturoidInvoice: vi.fn(),
  createFakturoidProforma: vi.fn(),
  createFakturoidSubject: vi.fn(),
  isFakturoidConfigured: vi.fn(),
  markFakturoidInvoicePaid: vi.fn(),
}))

vi.mock('~/server/utils/fio', () => ({ fetchFioTransactions: vi.fn() }))
vi.mock('~/server/utils/spayd', () => ({ buildSpayd: vi.fn(() => 'SPD*1.0') }))
vi.mock('~/server/utils/stripe', () => ({ getStripe: vi.fn(), isStripeConfigured: vi.fn() }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn(), addServerBreadcrumb: vi.fn() }))

/* eslint-disable import/first -- vitest hoists the vi.mock() calls above these imports of the mocked modules; declaring mocks before importing is intentional */
import * as depositRepo from '~/server/repos/depositRepo'
import * as fakturoid from '~/server/utils/fakturoid'
import * as fio from '~/server/utils/fio'
import * as stripe from '~/server/utils/stripe'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { addServerBreadcrumb, captureServerError } from '~/server/utils/observability'
import type { DepositUserRow, SettledDeposit } from '~/server/repos/depositRepo'
import type { InvoiceRow } from '~/server/db/schema'

const deposit = await vi.importActual<typeof import('~/server/utils/deposit')>('~/server/utils/deposit')
const {
  ensureOpenDepositInvoice,
  issueDepositTransfer,
  getDepositStatus,
  settleInFakturoid,
  expireStripeSessions,
  finalizeDepositSettlement,
  sendDepositPaidEmail,
  processFioPayments: realProcessFioPayments,
} = deposit

const FakturoidApiError = fakturoid.FakturoidApiError

const g = globalThis as Record<string, unknown>

const BANK_CONFIG = {
  depositIbanCzk: 'CZ65 0800 0000 0019 2000 0145',
  depositIbanEur: 'CZ65 0800 0000 0019 2000 0146',
  depositAccountCzk: '2903525501/2010',
  depositAccountEur: '2503525502/2010',
  depositRecipient: 'East West 24 s.r.o.',
}

const setConfig = (extra: Record<string, unknown> = {}) => {
  g.useRuntimeConfig = vi.fn(() => ({
    ...BANK_CONFIG,
    fioTokenCzk: 'czk-token',
    fioTokenEur: 'eur-token',
    public: { baseUrl: 'https://auction24.cz' },
    ...extra,
  }))
}

const makeUser = (over: Partial<DepositUserRow> = {}): DepositUserRow =>
  ({
    id: 'u1',
    email: 'buyer@example.com',
    fullName: 'Jane Buyer',
    depositRequired: true,
    depositBalanceAmount: null,
    depositBalanceCurrency: null,
    depositVs: '1234567890',
    fakturoidId: null,
    invoiceDueDays: 7,
    languageCode: 'cz',
    ...over,
  }) as unknown as DepositUserRow

const makeInvoice = (over: Partial<InvoiceRow> = {}): InvoiceRow =>
  ({
    id: 'inv1',
    userId: 'u1',
    priceAmount: '10000',
    priceCurrency: 'CZK',
    variableSymbol: '1234567890',
    url: null,
    fakturoidId: null,
    paidAt: null,
    ...over,
  }) as unknown as InvoiceRow

const makeSettled = (over: Partial<SettledDeposit> = {}): SettledDeposit => ({
  invoiceId: 'inv1',
  userId: 'u1',
  amount: 10000,
  currency: 'CZK',
  vs: '1234567890',
  fakturoidId: 42,
  paidOn: new Date('2026-06-19T00:00:00Z'),
  canceledSessionIds: [],
  canceledFakturoidIds: [],
  ...over,
})

beforeEach(() => {
  setConfig()
  vi.mocked(depositRepo.loadProcessedFioIds).mockResolvedValue(new Set())
  vi.mocked(fakturoid.isFakturoidConfigured).mockReturnValue(true)
  vi.mocked(stripe.isStripeConfigured).mockReturnValue(true)
})

describe('deposit: ensureOpenDepositInvoice', () => {
  it('throws 404 when the user is not found', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(undefined)
    await expect(ensureOpenDepositInvoice('u1', 'CZK')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 409 when the deposit is already paid (balance > 0)', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ depositBalanceAmount: '500' as never }))
    await expect(ensureOpenDepositInvoice('u1', 'CZK')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('throws 409 when the user is exempt (depositRequired=false)', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ depositRequired: false }))
    await expect(ensureOpenDepositInvoice('u1', 'CZK')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('throws 503 when the bank config is missing for the currency', async () => {
    setConfig({ depositIbanCzk: '' })
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    await expect(ensureOpenDepositInvoice('u1', 'CZK')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('reuses an existing open invoice', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    const existing = makeInvoice()
    vi.mocked(depositRepo.findOpenDepositInvoice).mockResolvedValue(existing)
    const ctx = await ensureOpenDepositInvoice('u1', 'CZK')
    expect(ctx.invoice).toBe(existing)
    expect(depositRepo.recordDepositInvoice).not.toHaveBeenCalled()
  })

  it('records a new invoice when none is open', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findOpenDepositInvoice).mockResolvedValue(undefined)
    const created = makeInvoice({ id: 'inv2' })
    vi.mocked(depositRepo.recordDepositInvoice).mockResolvedValue(created)
    const ctx = await ensureOpenDepositInvoice('u1', 'EUR')
    expect(ctx.invoice).toBe(created)
    expect(depositRepo.recordDepositInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', currency: 'EUR', amount: 500 }),
    )
  })
})

describe('deposit: issueDepositTransfer', () => {
  it('issues a proforma when the invoice has no fakturoidId', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findOpenDepositInvoice).mockResolvedValue(makeInvoice())
    vi.mocked(depositRepo.setUserFakturoidId).mockResolvedValue(99)
    vi.mocked(fakturoid.createFakturoidSubject).mockResolvedValue(99)
    vi.mocked(fakturoid.createFakturoidProforma).mockResolvedValue({
      id: 7,
      publicHtmlUrl: 'https://fakturoid/doc/7',
    } as never)

    const details = await issueDepositTransfer('u1', 'CZK')
    expect(details.invoiceUrl).toBe('https://fakturoid/doc/7')
    expect(details.amount).toBe(10000)
    expect(fakturoid.createFakturoidSubject).toHaveBeenCalled()
  })

  it('reuses an existing fakturoid subject when the user already has one', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ fakturoidId: 55 }))
    vi.mocked(depositRepo.findOpenDepositInvoice).mockResolvedValue(makeInvoice())
    vi.mocked(fakturoid.createFakturoidProforma).mockResolvedValue({
      id: 8,
      publicHtmlUrl: 'https://fakturoid/doc/8',
    } as never)

    const details = await issueDepositTransfer('u1', 'CZK')
    expect(details.invoiceUrl).toBe('https://fakturoid/doc/8')
    expect(fakturoid.createFakturoidSubject).not.toHaveBeenCalled()
  })

  it('falls back to the existing invoice url when Fakturoid is not configured', async () => {
    vi.mocked(fakturoid.isFakturoidConfigured).mockReturnValue(false)
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findOpenDepositInvoice).mockResolvedValue(makeInvoice({ url: 'https://prior/url' }))

    const details = await issueDepositTransfer('u1', 'CZK')
    expect(details.invoiceUrl).toBe('https://prior/url')
    expect(fakturoid.createFakturoidProforma).not.toHaveBeenCalled()
  })

  it('keeps the existing url when the invoice already carries a fakturoidId', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findOpenDepositInvoice).mockResolvedValue(
      makeInvoice({ fakturoidId: 12, url: 'https://existing/12' }),
    )

    const details = await issueDepositTransfer('u1', 'CZK')
    expect(details.invoiceUrl).toBe('https://existing/12')
    expect(fakturoid.createFakturoidProforma).not.toHaveBeenCalled()
  })

  it('swallows a Fakturoid proforma failure and keeps the original url', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ fakturoidId: 55 }))
    vi.mocked(depositRepo.findOpenDepositInvoice).mockResolvedValue(makeInvoice({ url: null }))
    vi.mocked(fakturoid.createFakturoidProforma).mockRejectedValue(new Error('fakturoid down'))

    const details = await issueDepositTransfer('u1', 'CZK')
    expect(details.invoiceUrl).toBeNull()
  })

  it('uses default amount and vs when the invoice fields are missing', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findOpenDepositInvoice).mockResolvedValue(
      makeInvoice({ priceAmount: null, variableSymbol: null, fakturoidId: 1, url: 'u' }),
    )

    const details = await issueDepositTransfer('u1', 'EUR')
    expect(details.amount).toBe(500)
    expect(details.vs).toBe('1234567890')
  })
})

describe('deposit: getDepositStatus', () => {
  it('throws 404 for an unknown user', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(undefined)
    await expect(getDepositStatus('u1')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('returns paid with amount when a balance exists', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(
      makeUser({ depositBalanceAmount: '10000' as never, depositBalanceCurrency: 'CZK' }),
    )
    const status = await getDepositStatus('u1')
    expect(status).toEqual({ state: 'paid', paid: { amount: 10000, currency: 'CZK' } })
  })

  it('defaults the balance currency to EUR when missing', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(
      makeUser({ depositBalanceAmount: '500' as never, depositBalanceCurrency: null }),
    )
    const status = await getDepositStatus('u1')
    expect(status.paid).toEqual({ amount: 500, currency: 'EUR' })
  })

  it('returns paid without amount for an exempt user (no balance)', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ depositRequired: false }))
    const status = await getDepositStatus('u1')
    expect(status).toEqual({ state: 'paid', paid: undefined })
  })

  it('returns none when there is no open invoice', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findAnyOpenDepositInvoice).mockResolvedValue(undefined)
    expect(await getDepositStatus('u1')).toEqual({ state: 'none' })
  })

  it('returns none when the open invoice has no price', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findAnyOpenDepositInvoice).mockResolvedValue(makeInvoice({ priceAmount: null }))
    expect(await getDepositStatus('u1')).toEqual({ state: 'none' })
  })

  it('returns none when the open invoice currency is not a deposit currency', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findAnyOpenDepositInvoice).mockResolvedValue(makeInvoice({ priceCurrency: 'USD' }))
    expect(await getDepositStatus('u1')).toEqual({ state: 'none' })
  })

  it('returns none when the open invoice currency is null', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findAnyOpenDepositInvoice).mockResolvedValue(makeInvoice({ priceCurrency: null }))
    expect(await getDepositStatus('u1')).toEqual({ state: 'none' })
  })

  it('returns pending with bank details for an open invoice', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(depositRepo.findAnyOpenDepositInvoice).mockResolvedValue(makeInvoice({ url: 'https://inv/url' }))
    const status = await getDepositStatus('u1')
    expect(status.state).toBe('pending')
    expect(status.pending?.invoiceUrl).toBe('https://inv/url')
    expect(status.pending?.vs).toBe('1234567890')
  })

  it('falls back to the user deposit vs when the invoice vs is missing', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ depositVs: '9999999999' }))
    vi.mocked(depositRepo.findAnyOpenDepositInvoice).mockResolvedValue(makeInvoice({ variableSymbol: null }))
    const status = await getDepositStatus('u1')
    expect(status.pending?.vs).toBe('9999999999')
  })
})

describe('deposit: settleInFakturoid', () => {
  it('is a no-op when Fakturoid is not configured', async () => {
    vi.mocked(fakturoid.isFakturoidConfigured).mockReturnValue(false)
    await settleInFakturoid(makeSettled())
    expect(fakturoid.markFakturoidInvoicePaid).not.toHaveBeenCalled()
  })

  it('marks paid directly when the settled deposit has a fakturoidId', async () => {
    await settleInFakturoid(makeSettled({ fakturoidId: 42 }))
    expect(fakturoid.markFakturoidInvoicePaid).toHaveBeenCalledWith(42, expect.any(String), 10000)
    expect(depositRepo.setInvoiceFakturoidPaidAt).toHaveBeenCalledWith('inv1')
  })

  it('creates the proforma first when no fakturoidId is present', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ fakturoidId: 77 }))
    vi.mocked(fakturoid.createFakturoidProforma).mockResolvedValue({
      id: 13,
      publicHtmlUrl: 'https://fakturoid/13',
    } as never)
    await settleInFakturoid(makeSettled({ fakturoidId: null }))
    expect(fakturoid.markFakturoidInvoicePaid).toHaveBeenCalledWith(13, expect.any(String), 10000)
  })

  it('bails when no fakturoidId and the user vanished', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(undefined)
    await settleInFakturoid(makeSettled({ fakturoidId: null }))
    expect(fakturoid.createFakturoidProforma).not.toHaveBeenCalled()
    expect(fakturoid.markFakturoidInvoicePaid).not.toHaveBeenCalled()
  })

  it('bails when no fakturoidId and vs is null', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    await settleInFakturoid(makeSettled({ fakturoidId: null, vs: null }))
    expect(fakturoid.createFakturoidProforma).not.toHaveBeenCalled()
  })

  it('bails when no fakturoidId and currency is not a deposit currency', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    await settleInFakturoid(makeSettled({ fakturoidId: null, currency: 'USD' }))
    expect(fakturoid.createFakturoidProforma).not.toHaveBeenCalled()
  })

  it('bails when proforma creation fails (returns null)', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ fakturoidId: 77 }))
    vi.mocked(fakturoid.createFakturoidProforma).mockRejectedValue(new Error('boom'))
    await settleInFakturoid(makeSettled({ fakturoidId: null }))
    expect(fakturoid.markFakturoidInvoicePaid).not.toHaveBeenCalled()
  })

  it('stamps and stays silent on a 403 from markFakturoidInvoicePaid', async () => {
    vi.mocked(fakturoid.markFakturoidInvoicePaid).mockRejectedValue(new FakturoidApiError('paid', 403))
    await settleInFakturoid(makeSettled())
    expect(depositRepo.setInvoiceFakturoidPaidAt).toHaveBeenCalledWith('inv1')
    expect(vi.mocked(captureServerError)).not.toHaveBeenCalled()
  })

  it('stamps and logs on a non-403 4xx from markFakturoidInvoicePaid', async () => {
    vi.mocked(fakturoid.markFakturoidInvoicePaid).mockRejectedValue(new FakturoidApiError('rejected', 422))
    await settleInFakturoid(makeSettled())
    expect(depositRepo.setInvoiceFakturoidPaidAt).toHaveBeenCalledWith('inv1')
    expect(vi.mocked(captureServerError)).toHaveBeenCalled()
  })

  it('leaves the invoice pending on a 5xx from markFakturoidInvoicePaid', async () => {
    vi.mocked(fakturoid.markFakturoidInvoicePaid).mockRejectedValue(new FakturoidApiError('upstream', 500))
    await settleInFakturoid(makeSettled())
    expect(depositRepo.setInvoiceFakturoidPaidAt).not.toHaveBeenCalled()
    expect(vi.mocked(captureServerError)).toHaveBeenCalled()
  })

  it('leaves the invoice pending on a non-Fakturoid error from markFakturoidInvoicePaid', async () => {
    vi.mocked(fakturoid.markFakturoidInvoicePaid).mockRejectedValue(new Error('network'))
    await settleInFakturoid(makeSettled())
    expect(depositRepo.setInvoiceFakturoidPaidAt).not.toHaveBeenCalled()
    expect(vi.mocked(captureServerError)).toHaveBeenCalled()
  })
})

describe('deposit: expireStripeSessions', () => {
  it('is a no-op for an empty session list', async () => {
    await expireStripeSessions([])
    expect(stripe.getStripe).not.toHaveBeenCalled()
  })

  it('is a no-op when Stripe is not configured', async () => {
    vi.mocked(stripe.isStripeConfigured).mockReturnValue(false)
    await expireStripeSessions(['cs_1'])
    expect(stripe.getStripe).not.toHaveBeenCalled()
  })

  it('expires each session', async () => {
    const expire = vi.fn().mockResolvedValue({})
    vi.mocked(stripe.getStripe).mockReturnValue({ checkout: { sessions: { expire } } } as never)
    await expireStripeSessions(['cs_1', 'cs_2'])
    expect(expire).toHaveBeenCalledTimes(2)
  })

  it('swallows expire failures via breadcrumb', async () => {
    const expire = vi.fn().mockRejectedValue(new Error('already expired'))
    vi.mocked(stripe.getStripe).mockReturnValue({ checkout: { sessions: { expire } } } as never)
    await expireStripeSessions(['cs_1'])
    expect(vi.mocked(addServerBreadcrumb)).toHaveBeenCalledWith('stripe session expire skipped', { id: 'cs_1' })
  })
})

describe('deposit: finalizeDepositSettlement', () => {
  it('runs the full pipeline (expire sessions, cancel siblings, settle)', async () => {
    const expire = vi.fn().mockResolvedValue({})
    vi.mocked(stripe.getStripe).mockReturnValue({ checkout: { sessions: { expire } } } as never)
    vi.mocked(fakturoid.cancelFakturoidInvoice).mockResolvedValue(undefined)
    await finalizeDepositSettlement(makeSettled({ canceledSessionIds: ['cs_1'], canceledFakturoidIds: [11, 12] }))
    expect(expire).toHaveBeenCalledTimes(1)
    expect(fakturoid.cancelFakturoidInvoice).toHaveBeenCalledTimes(2)
    expect(fakturoid.markFakturoidInvoicePaid).toHaveBeenCalled()
  })

  it('skips sibling cancellation when there are no fakturoid ids', async () => {
    await finalizeDepositSettlement(makeSettled({ canceledFakturoidIds: [] }))
    expect(fakturoid.cancelFakturoidInvoice).not.toHaveBeenCalled()
  })

  it('skips sibling cancellation when Fakturoid is not configured', async () => {
    vi.mocked(fakturoid.isFakturoidConfigured).mockReturnValue(false)
    await finalizeDepositSettlement(makeSettled({ canceledFakturoidIds: [11] }))
    expect(fakturoid.cancelFakturoidInvoice).not.toHaveBeenCalled()
  })

  it('logs but does not throw when a sibling cancellation fails', async () => {
    vi.mocked(fakturoid.cancelFakturoidInvoice).mockRejectedValue(new Error('cancel failed'))
    await finalizeDepositSettlement(makeSettled({ canceledFakturoidIds: [11] }))
    expect(vi.mocked(captureServerError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'deposit.fakturoid.cancelSibling' }),
    )
  })

  it('catches a settleInFakturoid throw', async () => {
    // Force settleInFakturoid down the markPaid path and have setInvoiceFakturoidPaidAt throw
    // so the outer try/catch in finalize fires.
    vi.mocked(fakturoid.markFakturoidInvoicePaid).mockResolvedValue(undefined)
    vi.mocked(depositRepo.setInvoiceFakturoidPaidAt).mockRejectedValueOnce(new Error('db down'))
    await finalizeDepositSettlement(makeSettled())
    // markPaid's own try/catch absorbs that; the outer catch is defensive. Either way no throw.
    expect(fakturoid.markFakturoidInvoicePaid).toHaveBeenCalled()
  })
})

describe('deposit: sendDepositPaidEmail', () => {
  it('enqueues the localized confirmation email', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    await sendDepositPaidEmail(makeSettled())
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'buyer@example.com', templateKey: 'depositPaid', language: 'cz' }),
      { dedupKey: 'deposit-paid:inv1' },
    )
  })

  it('defaults the language to cz when missing', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ languageCode: null }))
    await sendDepositPaidEmail(makeSettled())
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ language: 'cz' }), expect.anything())
  })

  it('skips when the user has no email', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ email: null as unknown as string }))
    await sendDepositPaidEmail(makeSettled())
    expect(enqueueEmail).not.toHaveBeenCalled()
  })

  it('skips when the user is missing entirely', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(undefined)
    await sendDepositPaidEmail(makeSettled())
    expect(enqueueEmail).not.toHaveBeenCalled()
  })

  it('swallows an enqueue failure', async () => {
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    vi.mocked(enqueueEmail).mockRejectedValue(new Error('queue down'))
    await sendDepositPaidEmail(makeSettled())
    expect(vi.mocked(captureServerError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'deposit.email.paid' }),
    )
  })
})

const makeTx = (over: Record<string, unknown> = {}) => ({
  id: 'fio1',
  date: '2026-06-18',
  amount: 10000,
  currency: 'CZK',
  vs: '1234567890',
  counterAccount: '123',
  counterBankCode: '0800',
  counterName: 'Jane',
  message: 'Kauce',
  type: 'PRIJEM',
  raw: {},
  ...over,
})

describe('deposit: processFioPayments', () => {
  beforeEach(() => {
    // Default: nothing pending in the sweep, prune fine.
    vi.mocked(depositRepo.listPaidInvoicesPendingFakturoid).mockResolvedValue([])
    vi.mocked(depositRepo.pruneProcessedStripeEvents).mockResolvedValue(0)
  })

  it('skips accounts with no configured token', async () => {
    setConfig({ fioTokenCzk: '', fioTokenEur: '' })
    const result = await realProcessFioPayments()
    expect(result.skipped).toEqual(['CZK:unconfigured', 'EUR:unconfigured'])
    expect(fio.fetchFioTransactions).not.toHaveBeenCalled()
  })

  it('records a fetch error and continues', async () => {
    vi.mocked(fio.fetchFioTransactions).mockRejectedValue(new Error('fio 500'))
    const result = await realProcessFioPayments()
    expect(result.errors).toBe(2)
    expect(vi.mocked(captureServerError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'deposit.fio.fetch' }),
    )
  })

  it('marks accounts skipped when Fio throttles (null)', async () => {
    vi.mocked(fio.fetchFioTransactions).mockResolvedValue(null)
    const result = await realProcessFioPayments()
    expect(result.skipped).toEqual(['CZK:throttled', 'EUR:throttled'])
  })

  it('ignores non-positive amounts and currency mismatches', async () => {
    // CZK account sees a zero, a negative, and a EUR-currency tx — all skipped.
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx({ amount: 0 }), makeTx({ amount: -5 }), makeTx({ currency: 'EUR' })] as never)
      .mockResolvedValueOnce([] as never)
    const result = await realProcessFioPayments()
    expect(depositRepo.settleFioPayment).not.toHaveBeenCalled()
    expect(result.matched).toBe(0)
  })

  it('skips a payment that could not be claimed', async () => {
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx()] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(depositRepo.settleFioPayment).mockResolvedValue({ claimed: false, settled: null } as never)
    const result = await realProcessFioPayments()
    expect(result.matched).toBe(0)
    expect(result.unmatched).toBe(0)
  })

  it('reports an unmatched payment that was claimed but not settled', async () => {
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx({ vs: null })] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(depositRepo.settleFioPayment).mockResolvedValue({ claimed: true, settled: null } as never)
    const result = await realProcessFioPayments()
    expect(result.unmatched).toBe(1)
    expect(vi.mocked(captureServerError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'deposit.fio.unmatched' }),
    )
  })

  it('settles a matched payment and fires finalize + email', async () => {
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx()] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(depositRepo.settleFioPayment).mockResolvedValue({
      claimed: true,
      settled: makeSettled(),
    } as never)
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    const result = await realProcessFioPayments()
    expect(result.matched).toBe(1)
    expect(fakturoid.markFakturoidInvoicePaid).toHaveBeenCalled()
    expect(enqueueEmail).toHaveBeenCalled()
  })

  it('logs an overpaid breadcrumb when paid exceeds the required amount', async () => {
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx({ amount: 12000 })] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(depositRepo.settleFioPayment).mockResolvedValue({
      claimed: true,
      settled: makeSettled({ amount: 10000 }),
    } as never)
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser())
    await realProcessFioPayments()
    expect(vi.mocked(addServerBreadcrumb)).toHaveBeenCalledWith(
      'deposit overpaid',
      expect.objectContaining({ paid: 12000 }),
    )
  })

  it('builds the counter account from account + bank code', async () => {
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx()] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(depositRepo.settleFioPayment).mockResolvedValue({ claimed: false, settled: null } as never)
    await realProcessFioPayments()
    expect(depositRepo.settleFioPayment).toHaveBeenCalledWith(expect.objectContaining({ counterAccount: '123/0800' }))
  })

  it('passes through the bare counter account when no bank code', async () => {
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx({ counterBankCode: null })] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(depositRepo.settleFioPayment).mockResolvedValue({ claimed: false, settled: null } as never)
    await realProcessFioPayments()
    expect(depositRepo.settleFioPayment).toHaveBeenCalledWith(expect.objectContaining({ counterAccount: '123' }))
  })

  it('uses now() for paidOn when the tx date is missing', async () => {
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx({ date: null })] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(depositRepo.settleFioPayment).mockResolvedValue({ claimed: false, settled: null } as never)
    await realProcessFioPayments()
    expect(depositRepo.settleFioPayment).toHaveBeenCalledWith(expect.objectContaining({ paidOn: expect.any(Date) }))
  })

  it('records a per-item error and continues the batch', async () => {
    vi.mocked(fio.fetchFioTransactions)
      .mockResolvedValueOnce([makeTx()] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(depositRepo.settleFioPayment).mockRejectedValue(new Error('settle boom'))
    const result = await realProcessFioPayments()
    expect(result.errors).toBe(1)
    expect(vi.mocked(captureServerError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'deposit.fio.process' }),
    )
  })

  it('runs the Fakturoid sweep over pending invoices', async () => {
    setConfig({ fioTokenCzk: '', fioTokenEur: '' })
    vi.mocked(depositRepo.listPaidInvoicesPendingFakturoid).mockResolvedValue([
      {
        id: 'inv9',
        userId: 'u1',
        fakturoidId: 88,
        paidAt: new Date('2026-06-18T00:00:00Z'),
        priceAmount: '10000',
        priceCurrency: 'CZK',
        variableSymbol: '1234567890',
      },
    ])
    await realProcessFioPayments()
    expect(fakturoid.markFakturoidInvoicePaid).toHaveBeenCalledWith(88, expect.any(String), 10000)
  })

  it('handles a pending invoice with null fields in the sweep', async () => {
    setConfig({ fioTokenCzk: '', fioTokenEur: '' })
    vi.mocked(depositRepo.getUserForDeposit).mockResolvedValue(makeUser({ fakturoidId: 5 }))
    vi.mocked(fakturoid.createFakturoidProforma).mockResolvedValue({
      id: 21,
      publicHtmlUrl: 'https://fakturoid/21',
    } as never)
    vi.mocked(depositRepo.listPaidInvoicesPendingFakturoid).mockResolvedValue([
      {
        id: 'inv10',
        userId: 'u1',
        fakturoidId: null,
        paidAt: null,
        priceAmount: null,
        priceCurrency: 'CZK',
        variableSymbol: '1234567890',
      },
    ])
    await realProcessFioPayments()
    expect(fakturoid.createFakturoidProforma).toHaveBeenCalled()
  })

  it('skips the sweep when Fakturoid is not configured', async () => {
    setConfig({ fioTokenCzk: '', fioTokenEur: '' })
    vi.mocked(fakturoid.isFakturoidConfigured).mockReturnValue(false)
    await realProcessFioPayments()
    expect(depositRepo.listPaidInvoicesPendingFakturoid).not.toHaveBeenCalled()
  })

  it('logs but absorbs a sweep listing failure', async () => {
    setConfig({ fioTokenCzk: '', fioTokenEur: '' })
    vi.mocked(depositRepo.listPaidInvoicesPendingFakturoid).mockRejectedValue(new Error('list boom'))
    await realProcessFioPayments()
    expect(vi.mocked(captureServerError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'deposit.fakturoid.sweep' }),
    )
  })

  it('absorbs a prune failure with a breadcrumb', async () => {
    setConfig({ fioTokenCzk: '', fioTokenEur: '' })
    vi.mocked(depositRepo.pruneProcessedStripeEvents).mockRejectedValue(new Error('prune boom'))
    await realProcessFioPayments()
    expect(vi.mocked(addServerBreadcrumb)).toHaveBeenCalledWith('stripe events prune skipped')
  })
})
