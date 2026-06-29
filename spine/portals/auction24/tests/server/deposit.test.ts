import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureOpenDepositInvoice,
  expireStripeSessions,
  finalizeDepositSettlement,
  getDepositStatus,
  issueDepositTransfer,
  processFioPayments,
  sendDepositPaidEmail,
  settleInFakturoid,
} from '~/server/utils/deposit'
import * as repo from '~/server/repos/depositRepo'
import * as fak from '~/server/utils/fakturoid'
import { fetchFioTransactions } from '~/server/utils/fio'
import { getStripe, isStripeConfigured } from '~/server/utils/stripe'
import { enqueueEmail } from '~/server/utils/emailQueue'

vi.mock('~/server/repos/depositRepo', () => ({
  getUserForDeposit: vi.fn(),
  findOpenDepositInvoice: vi.fn(),
  findAnyOpenDepositInvoice: vi.fn(),
  recordDepositInvoice: vi.fn(),
  attachFakturoidDoc: vi.fn(),
  setUserFakturoidId: vi.fn(),
  setInvoiceFakturoidPaidAt: vi.fn(),
  listPaidInvoicesPendingFakturoid: vi.fn(),
  pruneProcessedStripeEvents: vi.fn(),
  loadProcessedFioIds: vi.fn(),
  settleFioPayment: vi.fn(),
}))
vi.mock('~/server/utils/fakturoid', () => ({
  FakturoidApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
  isFakturoidConfigured: vi.fn(() => false),
  createFakturoidSubject: vi.fn(),
  createFakturoidProforma: vi.fn(),
  markFakturoidInvoicePaid: vi.fn(),
  cancelFakturoidInvoice: vi.fn(),
}))
vi.mock('~/server/utils/fio', () => ({ fetchFioTransactions: vi.fn() }))
vi.mock('~/server/utils/stripe', () => ({ getStripe: vi.fn(), isStripeConfigured: vi.fn(() => false) }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn(), addServerBreadcrumb: vi.fn() }))

const cfg = {
  depositIbanCzk: 'CZ_CZK',
  depositAccountCzk: '2903525501/2010',
  depositIbanEur: 'CZ_EUR',
  depositAccountEur: '2503525502/2010',
  depositRecipient: 'EastWest',
  fioTokenCzk: 'tk-czk',
  fioTokenEur: 'tk-eur',
  public: { baseUrl: 'https://app.test' },
}

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  fullName: 'Jan',
  email: 'jan@x.cz',
  fakturoidId: null,
  invoiceDueDays: 14,
  depositRequired: true,
  depositBalanceAmount: null,
  depositBalanceCurrency: null,
  depositVs: '1234567890',
  languageCode: 'cz',
  address: null,
  ...over,
})

const settled = (over: Record<string, unknown> = {}) => ({
  invoiceId: 'inv1',
  userId: 'u1',
  amount: 10000,
  currency: 'CZK',
  vs: '1234567890',
  fakturoidId: null,
  paidOn: new Date('2025-01-01T00:00:00Z'),
  canceledSessionIds: [],
  canceledFakturoidIds: [],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => cfg
  vi.mocked(repo.loadProcessedFioIds).mockResolvedValue(new Set())
  vi.mocked(fak.isFakturoidConfigured).mockReturnValue(false)
  vi.mocked(isStripeConfigured).mockReturnValue(false)
  vi.mocked(repo.getUserForDeposit).mockResolvedValue(user() as never)
  // Defaults for fns whose result is chained with .catch() / iterated, so they never see undefined.
  vi.mocked(repo.pruneProcessedStripeEvents).mockResolvedValue(undefined as never)
  vi.mocked(repo.listPaidInvoicesPendingFakturoid).mockResolvedValue([] as never)
  vi.mocked(fak.cancelFakturoidInvoice).mockResolvedValue(undefined as never)
  vi.mocked(enqueueEmail).mockResolvedValue(undefined as never)
})

describe('ensureOpenDepositInvoice', () => {
  it('404s when the user is gone', async () => {
    vi.mocked(repo.getUserForDeposit).mockResolvedValue(undefined as never)
    await expect(ensureOpenDepositInvoice('u1', 'CZK')).rejects.toMatchObject({ statusCode: 404 })
  })
  it('409s when the deposit is already paid', async () => {
    vi.mocked(repo.getUserForDeposit).mockResolvedValue(user({ depositBalanceAmount: '10000' }) as never)
    await expect(ensureOpenDepositInvoice('u1', 'CZK')).rejects.toMatchObject({ statusCode: 409 })
  })
  it('reuses an existing open invoice', async () => {
    vi.mocked(repo.findOpenDepositInvoice).mockResolvedValue({ id: 'inv1' } as never)
    const { invoice } = await ensureOpenDepositInvoice('u1', 'CZK')
    expect(invoice).toMatchObject({ id: 'inv1' })
    expect(repo.recordDepositInvoice).not.toHaveBeenCalled()
  })
  it('creates a new invoice for the right amount when none is open', async () => {
    vi.mocked(repo.findOpenDepositInvoice).mockResolvedValue(undefined as never)
    vi.mocked(repo.recordDepositInvoice).mockResolvedValue({ id: 'inv-new' } as never)
    await ensureOpenDepositInvoice('u1', 'CZK')
    expect(repo.recordDepositInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', amount: 10000, currency: 'CZK', vs: '1234567890', iban: 'CZ_CZK' }),
    )
  })
})

describe('issueDepositTransfer', () => {
  it('returns bank details with a SPAYD string', async () => {
    vi.mocked(repo.findOpenDepositInvoice).mockResolvedValue({
      id: 'inv1',
      priceAmount: '10000',
      variableSymbol: '1234567890',
      url: null,
      fakturoidId: 1,
    } as never)
    const details = await issueDepositTransfer('u1', 'CZK')
    expect(details).toMatchObject({ iban: 'CZ_CZK', vs: '1234567890', amount: 10000, currency: 'CZK' })
    expect(details.spayd).toContain('SPD')
  })

  it('backfills the Fakturoid proforma when the invoice has none', async () => {
    vi.mocked(fak.isFakturoidConfigured).mockReturnValue(true)
    vi.mocked(repo.findOpenDepositInvoice).mockResolvedValue({
      id: 'inv1',
      priceAmount: '10000',
      variableSymbol: '1234567890',
      url: null,
      fakturoidId: null,
    } as never)
    vi.mocked(repo.setUserFakturoidId).mockResolvedValue(55 as never)
    vi.mocked(fak.createFakturoidSubject).mockResolvedValue(55 as never)
    vi.mocked(fak.createFakturoidProforma).mockResolvedValue({
      id: 9,
      publicHtmlUrl: 'https://f/9',
      variableSymbol: '1234567890',
    } as never)
    const details = await issueDepositTransfer('u1', 'CZK')
    expect(fak.createFakturoidProforma).toHaveBeenCalled()
    expect(details.invoiceUrl).toBe('https://f/9')
  })
})

describe('getDepositStatus', () => {
  it('reports a paid balance', async () => {
    vi.mocked(repo.getUserForDeposit).mockResolvedValue(
      user({ depositBalanceAmount: '10000', depositBalanceCurrency: 'CZK' }) as never,
    )
    expect(await getDepositStatus('u1')).toEqual({ state: 'paid', paid: { amount: 10000, currency: 'CZK' } })
  })
  it('reports an exempt user as paid without an amount', async () => {
    vi.mocked(repo.getUserForDeposit).mockResolvedValue(user({ depositRequired: false }) as never)
    expect(await getDepositStatus('u1')).toEqual({ state: 'paid', paid: undefined })
  })
  it('reports a pending open invoice', async () => {
    vi.mocked(repo.findAnyOpenDepositInvoice).mockResolvedValue({
      priceAmount: '500',
      priceCurrency: 'EUR',
      variableSymbol: '1234567890',
      url: null,
    } as never)
    const status = await getDepositStatus('u1')
    expect(status.state).toBe('pending')
    expect(status.pending).toMatchObject({ amount: 500, currency: 'EUR' })
  })
  it('reports none when there is no open invoice', async () => {
    vi.mocked(repo.findAnyOpenDepositInvoice).mockResolvedValue(undefined as never)
    expect(await getDepositStatus('u1')).toEqual({ state: 'none' })
  })
})

describe('expireStripeSessions', () => {
  it('does nothing without configured Stripe', async () => {
    await expireStripeSessions(['cs_1'])
    expect(getStripe).not.toHaveBeenCalled()
  })
  it('expires each session when configured', async () => {
    vi.mocked(isStripeConfigured).mockReturnValue(true)
    const expire = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getStripe).mockReturnValue({ checkout: { sessions: { expire } } } as never)
    await expireStripeSessions(['cs_1', 'cs_2'])
    expect(expire).toHaveBeenCalledTimes(2)
  })
})

describe('settleInFakturoid', () => {
  it('skips when Fakturoid is not configured', async () => {
    await settleInFakturoid(settled() as never)
    expect(fak.markFakturoidInvoicePaid).not.toHaveBeenCalled()
  })
  it('marks an existing document paid', async () => {
    vi.mocked(fak.isFakturoidConfigured).mockReturnValue(true)
    await settleInFakturoid(settled({ fakturoidId: 9 }) as never)
    expect(fak.markFakturoidInvoicePaid).toHaveBeenCalledWith(9, '2025-01-01', 10000)
    expect(repo.setInvoiceFakturoidPaidAt).toHaveBeenCalledWith('inv1')
  })
  it('treats a 4xx mark-paid as terminal and stamps the row', async () => {
    vi.mocked(fak.isFakturoidConfigured).mockReturnValue(true)
    vi.mocked(fak.markFakturoidInvoicePaid).mockRejectedValue(new fak.FakturoidApiError('gone', 404))
    await settleInFakturoid(settled({ fakturoidId: 9 }) as never)
    expect(repo.setInvoiceFakturoidPaidAt).toHaveBeenCalledWith('inv1')
  })
})

describe('sendDepositPaidEmail', () => {
  it('enqueues a localized confirmation', async () => {
    await sendDepositPaidEmail(settled() as never)
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'jan@x.cz', templateKey: 'depositPaid' }),
      { dedupKey: 'deposit-paid:inv1' },
    )
  })
  it('skips when the user has no email', async () => {
    vi.mocked(repo.getUserForDeposit).mockResolvedValue(user({ email: null }) as never)
    await sendDepositPaidEmail(settled() as never)
    expect(enqueueEmail).not.toHaveBeenCalled()
  })
})

describe('processFioPayments', () => {
  it('skips unconfigured accounts', async () => {
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ ...cfg, fioTokenCzk: '', fioTokenEur: '' })
    const res = await processFioPayments()
    expect(res.skipped).toEqual(['CZK:unconfigured', 'EUR:unconfigured'])
    expect(fetchFioTransactions).not.toHaveBeenCalled()
  })

  it('records a throttled account', async () => {
    vi.mocked(fetchFioTransactions).mockResolvedValue(null as never)
    const res = await processFioPayments()
    expect(res.skipped).toContain('CZK:throttled')
  })

  it('settles a matching payment and emails the payer', async () => {
    vi.mocked(fetchFioTransactions)
      .mockResolvedValueOnce([
        { id: 'f1', amount: 10000, currency: 'CZK', vs: '1234567890', date: '2025-01-01' },
      ] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(repo.settleFioPayment).mockResolvedValue({ claimed: true, settled: settled() } as never)
    const res = await processFioPayments()
    expect(res.matched).toBe(1)
    expect(enqueueEmail).toHaveBeenCalledOnce()
  })

  it('counts a claimed-but-unmatched payment without settling', async () => {
    vi.mocked(fetchFioTransactions)
      .mockResolvedValueOnce([{ id: 'f2', amount: 10000, currency: 'CZK', vs: 'xxx' }] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(repo.settleFioPayment).mockResolvedValue({ claimed: true, settled: null } as never)
    const res = await processFioPayments()
    expect(res.unmatched).toBe(1)
    expect(enqueueEmail).not.toHaveBeenCalled()
  })

  it('ignores outgoing or wrong-currency movements', async () => {
    vi.mocked(fetchFioTransactions)
      .mockResolvedValueOnce([
        { id: 'f3', amount: -5, currency: 'CZK' },
        { id: 'f4', amount: 100, currency: 'EUR' },
      ] as never)
      .mockResolvedValueOnce([] as never)
    await processFioPayments()
    expect(repo.settleFioPayment).not.toHaveBeenCalled()
  })

  it('still settles when the already-processed pre-filter query fails (degrades, never aborts)', async () => {
    vi.mocked(fetchFioTransactions)
      .mockResolvedValueOnce([
        { id: 'f9', amount: 10000, currency: 'CZK', vs: '1234567890', date: '2025-01-01' },
      ] as never)
      .mockResolvedValueOnce([] as never)
    vi.mocked(repo.loadProcessedFioIds).mockRejectedValueOnce(new Error('db down'))
    vi.mocked(repo.settleFioPayment).mockResolvedValue({ claimed: true, settled: settled() } as never)
    const res = await processFioPayments()
    expect(repo.settleFioPayment).toHaveBeenCalled()
    expect(res.matched).toBe(1)
  })
})

describe('finalizeDepositSettlement', () => {
  it('runs the post-settle pipeline best-effort', async () => {
    vi.mocked(fak.isFakturoidConfigured).mockReturnValue(true)
    await finalizeDepositSettlement(settled({ fakturoidId: 9, canceledFakturoidIds: [7] }) as never)
    expect(fak.cancelFakturoidInvoice).toHaveBeenCalledWith(7)
    expect(fak.markFakturoidInvoicePaid).toHaveBeenCalled()
  })
})

// The blocks above mock ~/server/utils/fakturoid and ~/server/utils/fio wholesale, so the real
// modules go untested. Pull the real implementations via importActual (bypasses the file-level
// vi.mock) and exercise them against stubbed fetch + useRuntimeConfig. fakturoid.ts caches its
// OAuth token and bank-account list in module scope; importActual returns one shared instance, so
// each test stubs fetch fresh and config carries a unique slug to avoid stale-cache cross-talk.
type FakturoidReal = typeof import('~/server/utils/fakturoid')
type FioReal = typeof import('~/server/utils/fio')

const TOKEN_URL = 'https://app.fakturoid.cz/api/v3/oauth/token'

const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body ?? ''),
})

interface FetchRoute {
  match: (url: string) => boolean
  res: () => unknown
}

const routeFetch = (routes: FetchRoute[]) =>
  vi.fn(async (url: string) => {
    const r = routes.find(route => route.match(String(url)))
    if (!r) throw new Error(`unrouted fetch: ${url}`)
    return r.res()
  })

const tokenRoute: FetchRoute = {
  match: u => u === TOKEN_URL,
  res: () => jsonRes({ access_token: 'tok', expires_in: 7200 }),
}

describe('real fakturoid module', () => {
  let real: FakturoidReal
  let prevConfig: unknown
  let slugCounter = 0

  const setConfig = (over: Record<string, unknown> = {}) => {
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({
      fakturoidSlug: `slug-${slugCounter++}`,
      fakturoidClientId: 'cid',
      fakturoidClientSecret: 'sec',
      ...over,
    })
  }

  const proformaArgs = {
    subjectId: 42,
    currency: 'CZK' as const,
    amount: 10000,
    lineName: 'Kauce',
    variableSymbol: '123',
    vatRate: 0,
    dueDays: 14,
    iban: 'CZ1234 56',
  }

  beforeEach(async () => {
    prevConfig = (globalThis as Record<string, unknown>).useRuntimeConfig
    setConfig()
    real = (await vi.importActual('~/server/utils/fakturoid')) as FakturoidReal
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = prevConfig
    vi.unstubAllGlobals()
  })

  it('isFakturoidConfigured reflects credential presence', () => {
    expect(real.isFakturoidConfigured()).toBe(true)
    setConfig({ fakturoidSlug: '' })
    expect(real.isFakturoidConfigured()).toBe(false)
  })

  it('throws FakturoidApiError when the token request fails', async () => {
    vi.stubGlobal('fetch', routeFetch([{ match: u => u === TOKEN_URL, res: () => jsonRes({ error: 'x' }, 500) }]))
    await expect(real.createFakturoidSubject({ fullName: 'x', email: 'x@x.cz' })).rejects.toMatchObject({ status: 500 })
  })

  it('reuses the cached token on a second call within its lifetime', async () => {
    const fetchMock = routeFetch([
      tokenRoute,
      { match: u => u.endsWith('/subjects.json'), res: () => jsonRes({ id: 1 }) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await real.createFakturoidSubject({ fullName: 'A', email: 'a@x.cz' })
    await real.createFakturoidSubject({ fullName: 'B', email: 'b@x.cz' })
    const tokenCalls = fetchMock.mock.calls.filter(c => c[0] === TOKEN_URL).length
    expect(tokenCalls).toBe(1)
  })

  it('createFakturoidSubject sends the full address and company fields', async () => {
    const fetchMock = routeFetch([
      tokenRoute,
      { match: u => u.endsWith('/subjects.json'), res: () => jsonRes({ id: 99 }) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const id = await real.createFakturoidSubject({
      fullName: 'Jan',
      email: 'jan@x.cz',
      companyName: 'ACME s.r.o.',
      companyIdNumber: '123',
      companyVatNumber: 'CZ123',
      address: { address: 'Main 1', city: 'Praha', zip: '11000', country: { code2: 'cz' } } as never,
    })
    expect(id).toBe(99)
    const subjectCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/subjects.json'))
    const sent = JSON.parse(
      ((subjectCall as unknown as [string, { body: string }] | undefined)?.[1] as { body: string }).body,
    )
    expect(sent).toMatchObject({ name: 'ACME s.r.o.', country: 'CZ', registration_no: '123', vat_no: 'CZ123' })
  })

  it('createFakturoidSubject falls back to fullName and drops empty address fields', async () => {
    const fetchMock = routeFetch([
      tokenRoute,
      { match: u => u.endsWith('/subjects.json'), res: () => jsonRes({ id: 5 }) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await real.createFakturoidSubject({ fullName: 'Solo', email: 'solo@x.cz', address: null })
    const subjectCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/subjects.json'))
    const sent = JSON.parse(
      ((subjectCall as unknown as [string, { body: string }] | undefined)?.[1] as { body: string }).body,
    )
    expect(sent.name).toBe('Solo')
    expect(sent.street).toBeUndefined()
    expect(sent.country).toBeUndefined()
  })

  it('createFakturoidProforma pins the matching bank account', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch([
        tokenRoute,
        { match: u => u.endsWith('/bank_accounts.json'), res: () => jsonRes([{ id: 7, iban: 'CZ12 3456' }]) },
        {
          match: u => u.endsWith('/invoices.json'),
          res: () => jsonRes({ id: 9, public_html_url: 'https://f/9', variable_symbol: '123' }),
        },
      ]),
    )
    const res = await real.createFakturoidProforma(proformaArgs)
    expect(res).toEqual({ id: 9, publicHtmlUrl: 'https://f/9', variableSymbol: '123' })
  })

  it('createFakturoidProforma warns and omits bank_account_id when no IBAN matches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = routeFetch([
      tokenRoute,
      { match: u => u.endsWith('/bank_accounts.json'), res: () => jsonRes([{ id: 7, iban: null }]) },
      {
        match: u => u.endsWith('/invoices.json'),
        res: () => jsonRes({ id: 1, public_html_url: 'u', variable_symbol: 'v' }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await real.createFakturoidProforma({ ...proformaArgs, iban: 'CZ-nomatch' })
    expect(warn).toHaveBeenCalled()
    const invoiceCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/invoices.json'))
    const sent = JSON.parse(
      ((invoiceCall as unknown as [string, { body: string }] | undefined)?.[1] as { body: string }).body,
    )
    expect(sent.bank_account_id).toBeUndefined()
    warn.mockRestore()
  })

  it('createFakturoidProforma warns when bank-account lookup itself fails', async () => {
    // The bank-account list is cached in module scope for 1h; jump past the TTL so this test's
    // failing /bank_accounts.json fetch (not a leftover cache from an earlier test) is exercised.
    vi.useFakeTimers()
    vi.advanceTimersByTime(3_600_001)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      routeFetch([
        tokenRoute,
        { match: u => u.endsWith('/bank_accounts.json'), res: () => jsonRes({ error: 'boom' }, 500) },
        {
          match: u => u.endsWith('/invoices.json'),
          res: () => jsonRes({ id: 2, public_html_url: 'u', variable_symbol: 'v' }),
        },
      ]),
    )
    try {
      const res = await real.createFakturoidProforma({ ...proformaArgs, iban: 'CZ-lookup-fail' })
      expect(res.id).toBe(2)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('cancelFakturoidInvoice re-mints once on a 401 then succeeds (204)', async () => {
    let fireCalls = 0
    vi.stubGlobal(
      'fetch',
      routeFetch([
        tokenRoute,
        {
          match: u => u.endsWith('/invoices/5/fire.json'),
          res: () => {
            fireCalls += 1
            return fireCalls === 1 ? jsonRes({}, 401) : jsonRes(undefined, 204)
          },
        },
      ]),
    )
    await expect(real.cancelFakturoidInvoice(5)).resolves.toBeUndefined()
    expect(fireCalls).toBe(2)
  })

  it('throws FakturoidApiError on a persistent non-ok API response', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch([tokenRoute, { match: u => u.endsWith('/subjects.json'), res: () => jsonRes({ error: 'bad' }, 422) }]),
    )
    await expect(real.createFakturoidSubject({ fullName: 'x', email: 'x@x.cz' })).rejects.toMatchObject({ status: 422 })
  })

  it('falls back to an empty body when reading the error response text rejects', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch([
        tokenRoute,
        {
          match: u => u.endsWith('/subjects.json'),
          res: () => ({
            ok: false,
            status: 500,
            json: async () => ({}),
            text: async () => Promise.reject(new Error('io')),
          }),
        },
      ]),
    )
    await expect(real.createFakturoidSubject({ fullName: 'x', email: 'x@x.cz' })).rejects.toMatchObject({ status: 500 })
  })

  it('markFakturoidInvoicePaid POSTs the payment record', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch([
        tokenRoute,
        { match: u => u.endsWith('/invoices/9/payments.json'), res: () => jsonRes(undefined, 204) },
      ]),
    )
    await expect(real.markFakturoidInvoicePaid(9, '2025-01-01', 10000)).resolves.toBeUndefined()
  })

  it('api throws when Fakturoid is not configured', async () => {
    setConfig({ fakturoidSlug: '' })
    await expect(real.markFakturoidInvoicePaid(1, '2025-01-01', 1)).rejects.toThrow('Fakturoid not configured')
  })
})

describe('real fio module', () => {
  let real: FioReal

  beforeEach(async () => {
    real = (await vi.importActual('~/server/utils/fio')) as FioReal
  })

  afterEach(() => vi.unstubAllGlobals())

  const wrap = (transaction: unknown) => ({ accountStatement: { transactionList: { transaction } } })
  const col = (value: unknown) => ({ value })

  describe('parseFioStatement', () => {
    it('returns [] for a non-array / missing transaction list', () => {
      expect(real.parseFioStatement(null)).toEqual([])
      expect(real.parseFioStatement({})).toEqual([])
      expect(real.parseFioStatement(wrap(null))).toEqual([])
      expect(real.parseFioStatement(wrap('nope'))).toEqual([])
    })

    it('parses a full credit row with a string date', () => {
      const rows = real.parseFioStatement(
        wrap([
          {
            column22: col(12345),
            column1: col(10000),
            column14: col('CZK'),
            column0: col('2023-08-25+0200'),
            column5: col('1234567890'),
            column2: col('2903525501'),
            column3: col('2010'),
            column10: col('Jan Novak'),
            column16: col('kauce'),
            column8: col('Bezhotovostní příjem'),
          },
        ]),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: '12345',
        amount: 10000,
        currency: 'CZK',
        date: '2023-08-25',
        vs: '1234567890',
        counterAccount: '2903525501',
        counterName: 'Jan Novak',
        type: 'Bezhotovostní příjem',
      })
    })

    it('accepts epoch-ms numeric dates and nulls unparseable / empty / whitespace optionals', () => {
      const rows = real.parseFioStatement(
        wrap([
          {
            column22: col('id2'),
            column1: col(500),
            column14: col('EUR'),
            column0: col(1_692_950_400_000),
            column5: col(''),
            // Whitespace-only survives colValue's exact-'' guard but colString trims it to null.
            column2: col('   '),
            column10: undefined,
          },
        ]),
      )
      expect(rows[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(rows[0]!.vs).toBeNull()
      expect(rows[0]!.counterAccount).toBeNull()
      expect(rows[0]!.counterName).toBeNull()
    })

    it('nulls a NaN numeric date and a non-ISO string date', () => {
      const rows = real.parseFioStatement(
        wrap([
          { column22: col('a'), column1: col(1), column14: col('CZK'), column0: col(Number.NaN) },
          { column22: col('b'), column1: col(1), column14: col('CZK'), column0: col('not-a-date') },
          { column22: col('c'), column1: col(1), column14: col('CZK'), column0: col(null) },
        ]),
      )
      expect(rows.map(r => r.date)).toEqual([null, null, null])
    })

    it('skips rows missing id, with a non-finite amount, or missing currency', () => {
      const rows = real.parseFioStatement(
        wrap([
          { column1: col(1), column14: col('CZK') },
          { column22: col('x'), column1: col('abc'), column14: col('CZK') },
          { column22: col('y'), column1: col(1) },
        ]),
      )
      expect(rows).toEqual([])
    })
  })

  describe('fetchFioTransactions', () => {
    it('parses transactions on a 2xx response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonRes(wrap([{ column22: col('z'), column1: col(7), column14: col('CZK') }]))),
      )
      const txs = await real.fetchFioTransactions('tok', '2025-01-01', '2025-01-07')
      expect(txs).toHaveLength(1)
      expect(txs?.[0]).toMatchObject({ id: 'z', amount: 7, currency: 'CZK' })
    })

    it('returns null on a 409 throttle', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonRes({}, 409)),
      )
      expect(await real.fetchFioTransactions('tok', '2025-01-01', '2025-01-07')).toBeNull()
    })

    it('throws on a non-ok, non-409 response without leaking the token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonRes({}, 500)),
      )
      await expect(real.fetchFioTransactions('secret-token', '2025-01-01', '2025-01-07')).rejects.toThrow(
        'Fio transactions fetch failed: HTTP 500',
      )
      await expect(real.fetchFioTransactions('secret-token', '2025-01-01', '2025-01-07')).rejects.not.toThrow(
        /secret-token/,
      )
    })
  })
})
