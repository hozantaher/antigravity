import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// fakturoid.ts caches the OAuth token and bank-account list in module scope; reset the module
// per test so each starts with empty caches. Only global fetch + useRuntimeConfig are external.
type Fakturoid = typeof import('~/server/utils/fakturoid')
let fak: Fakturoid

const g = globalThis as Record<string, unknown>
const TOKEN_URL = 'https://app.fakturoid.cz/api/v3/oauth/token'

const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body ?? ''),
})

interface Route {
  match: (url: string) => boolean
  res: () => unknown
}
const routeFetch = (routes: Route[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const r = routes.find(route => route.match(String(url)))
      if (!r) throw new Error(`unrouted fetch: ${url}`)
      return r.res()
    }),
  )
const tokenRoute: Route = { match: u => u === TOKEN_URL, res: () => jsonRes({ access_token: 'tok', expires_in: 7200 }) }

beforeEach(async () => {
  vi.resetModules()
  g.useRuntimeConfig = () => ({ fakturoidSlug: 'eastwest24', fakturoidClientId: 'cid', fakturoidClientSecret: 'sec' })
  fak = await import('~/server/utils/fakturoid')
})
afterEach(() => vi.unstubAllGlobals())

describe('isFakturoidConfigured', () => {
  it('reflects whether the credentials are present', () => {
    expect(fak.isFakturoidConfigured()).toBe(true)
    g.useRuntimeConfig = () => ({})
    expect(fak.isFakturoidConfigured()).toBe(false)
  })
})

describe('createFakturoidSubject', () => {
  it('mints a token then POSTs the subject and returns its id', async () => {
    routeFetch([tokenRoute, { match: u => u.endsWith('/subjects.json'), res: () => jsonRes({ id: 42 }) }])
    expect(await fak.createFakturoidSubject({ fullName: 'Jan', email: 'jan@x.cz' })).toBe(42)
  })
})

describe('createFakturoidProforma', () => {
  it('pins the bank account whose IBAN matches and returns the proforma', async () => {
    routeFetch([
      tokenRoute,
      { match: u => u.endsWith('/bank_accounts.json'), res: () => jsonRes([{ id: 7, iban: 'CZ12 3456' }]) },
      {
        match: u => u.endsWith('/invoices.json'),
        res: () => jsonRes({ id: 9, public_html_url: 'https://f/9', variable_symbol: '123' }),
      },
    ])
    const res = await fak.createFakturoidProforma({
      subjectId: 42,
      currency: 'CZK',
      amount: 10000,
      lineName: 'Kauce',
      variableSymbol: '123',
      vatRate: 0,
      dueDays: 14,
      iban: 'CZ1234 56',
    })
    expect(res).toEqual({ id: 9, publicHtmlUrl: 'https://f/9', variableSymbol: '123' })
  })

  it('warns but still creates the proforma when no bank account matches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    routeFetch([
      tokenRoute,
      { match: u => u.endsWith('/bank_accounts.json'), res: () => jsonRes([{ id: 7, iban: 'CZ99' }]) },
      {
        match: u => u.endsWith('/invoices.json'),
        res: () => jsonRes({ id: 9, public_html_url: 'u', variable_symbol: 'v' }),
      },
    ])
    await fak.createFakturoidProforma({
      subjectId: 42,
      currency: 'EUR',
      amount: 500,
      lineName: 'x',
      variableSymbol: 'v',
      vatRate: 0,
      dueDays: 14,
      iban: 'CZ-no-match',
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('api error handling', () => {
  it('throws FakturoidApiError on a non-ok response', async () => {
    routeFetch([tokenRoute, { match: u => u.endsWith('/subjects.json'), res: () => jsonRes({ error: 'bad' }, 422) }])
    await expect(fak.createFakturoidSubject({ fullName: 'x', email: 'x@x.cz' })).rejects.toMatchObject({ status: 422 })
  })

  it('drops the cached token and re-mints once on a 401, then retries', async () => {
    let fireCalls = 0
    routeFetch([
      tokenRoute,
      {
        match: u => u.endsWith('/invoices/5/fire.json'),
        res: () => {
          fireCalls++
          return fireCalls === 1 ? jsonRes({}, 401) : jsonRes(undefined, 204)
        },
      },
    ])
    await fak.cancelFakturoidInvoice(5)
    expect(fireCalls).toBe(2)
  })
})

describe('markFakturoidInvoicePaid', () => {
  it('POSTs the payment record', async () => {
    routeFetch([
      tokenRoute,
      { match: u => u.endsWith('/invoices/9/payments.json'), res: () => jsonRes(undefined, 204) },
    ])
    await expect(fak.markFakturoidInvoicePaid(9, '2025-01-01', 10000)).resolves.toBeUndefined()
  })
})
