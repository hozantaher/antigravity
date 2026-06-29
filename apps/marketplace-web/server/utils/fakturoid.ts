import { Buffer } from 'node:buffer'
import type { Address, DepositCurrency } from '~/models'
import { COMPANY } from '~/utils/company'

const TOKEN_URL = 'https://app.fakturoid.cz/api/v3/oauth/token'
const API_ROOT = 'https://app.fakturoid.cz/api/v3'
// A hung (not erroring) upstream must become an error, or the best-effort catch
// paths never fire and the payment endpoints block on Fakturoid.
const FETCH_TIMEOUT_MS = 15_000

export class FakturoidApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

interface FakturoidConfig {
  slug: string
  clientId: string
  clientSecret: string
  userAgent: string
}

const readConfig = (): FakturoidConfig | null => {
  const c = useRuntimeConfig()
  if (!c.fakturoidSlug || !c.fakturoidClientId || !c.fakturoidClientSecret) return null
  // Fakturoid rejects requests whose User-Agent lacks a contact e-mail.
  return {
    slug: c.fakturoidSlug,
    clientId: c.fakturoidClientId,
    clientSecret: c.fakturoidClientSecret,
    userAgent: `Auction24 (${COMPANY.email})`,
  }
}

export const isFakturoidConfigured = (): boolean => readConfig() !== null

// Client-credentials tokens live 2h and have no refresh — cache and re-mint 60s early.
let cachedToken: { value: string; expiresAt: number } | null = null

const getToken = async (cfg: FakturoidConfig): Promise<string> => {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': cfg.userAgent,
    },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new FakturoidApiError(`Fakturoid token request failed: ${res.status}`, res.status)
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = { value: json.access_token, expiresAt: now + json.expires_in * 1000 }
  return json.access_token
}

const api = async <T>(path: string, init: RequestInit): Promise<T> => {
  const cfg = readConfig()
  if (!cfg) throw new Error('Fakturoid not configured')

  const call = async (token: string): Promise<Response> =>
    fetch(`${API_ROOT}/accounts/${cfg.slug}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': cfg.userAgent,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

  let res = await call(await getToken(cfg))
  if (res.status === 401) {
    // Token revoked server-side (secret rotation) while still locally "valid" —
    // drop the cache and re-mint once instead of poisoning every call for ~2h.
    cachedToken = null
    res = await call(await getToken(cfg))
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new FakturoidApiError(`Fakturoid ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`, res.status)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

interface FakturoidBankAccount {
  id: number
  iban: string | null
}

const normalizeIban = (iban: string): string => iban.replace(/\s+/g, '').toUpperCase()

let cachedBankAccounts: { value: FakturoidBankAccount[]; expiresAt: number } | null = null

// Maps a deposit IBAN to the Fakturoid bank account id so the proforma's payment
// instructions show the monitored Fio account, not the account default. Null when
// the IBAN isn't configured in Fakturoid (ops must add it there).
const resolveBankAccountId = async (iban: string): Promise<number | null> => {
  const now = Date.now()
  if (!cachedBankAccounts || cachedBankAccounts.expiresAt <= now) {
    const accounts = await api<FakturoidBankAccount[]>('/bank_accounts.json', { method: 'GET' })
    cachedBankAccounts = { value: accounts, expiresAt: now + 3_600_000 }
  }
  const target = normalizeIban(iban)
  return cachedBankAccounts.value.find(a => a.iban && normalizeIban(a.iban) === target)?.id ?? null
}

export interface FakturoidSubjectInput {
  fullName: string
  email: string
  companyName?: string | null
  companyIdNumber?: string | null
  companyVatNumber?: string | null
  address?: Address | null
}

const undef = (value: string | null | undefined): string | undefined => value || undefined

// Creates a Fakturoid subject (customer) from the user's billing data. Caller persists the returned id.
export const createFakturoidSubject = async (user: FakturoidSubjectInput): Promise<number> => {
  const addr = user.address
  const data = await api<{ id: number }>('/subjects.json', {
    method: 'POST',
    body: JSON.stringify({
      name: user.companyName || user.fullName,
      email: undef(user.email),
      street: undef(addr?.address),
      city: undef(addr?.city),
      zip: undef(addr?.zip),
      // Local Country.code2 is lowercase; Fakturoid expects ISO 3166-1 alpha-2 uppercase.
      country: undef(addr?.country?.code2?.toUpperCase()),
      registration_no: undef(user.companyIdNumber),
      vat_no: undef(user.companyVatNumber),
      type: 'customer',
    }),
  })
  return data.id
}

export interface FakturoidInvoiceResult {
  id: number
  publicHtmlUrl: string
  variableSymbol: string
}

interface CreateProformaArgs {
  subjectId: number
  currency: DepositCurrency
  amount: number
  lineName: string
  variableSymbol: string
  vatRate: number
  dueDays: number
  // Deposit collection IBAN — resolved to a Fakturoid bank_account_id so the
  // document's payment instructions point at the account the Fio cron watches.
  iban: string
}

// Zálohová faktura for the deposit. The deposit is a refundable guarantee, not a
// taxable supply → vat 0 and no follow-up tax document after payment.
export const createFakturoidProforma = async (args: CreateProformaArgs): Promise<FakturoidInvoiceResult> => {
  const bankAccountId = await resolveBankAccountId(args.iban).catch(() => null)
  if (bankAccountId == null) {
    console.warn(
      `[fakturoid] no bank account matches ${args.iban} — the proforma will show the Fakturoid account default; ` +
        'add the Fio deposit accounts in Fakturoid settings',
    )
  }
  const data = await api<{
    id: number
    public_html_url: string
    variable_symbol: string
  }>('/invoices.json', {
    method: 'POST',
    body: JSON.stringify({
      document_type: 'proforma',
      proforma_followup_document: 'none',
      subject_id: args.subjectId,
      currency: args.currency,
      payment_method: 'bank',
      variable_symbol: args.variableSymbol,
      due: args.dueDays,
      ...(bankAccountId != null ? { bank_account_id: bankAccountId } : {}),
      lines: [{ name: args.lineName, quantity: 1, unit_price: args.amount, vat_rate: args.vatRate }],
    }),
  })
  return {
    id: data.id,
    publicHtmlUrl: data.public_html_url,
    variableSymbol: data.variable_symbol,
  }
}

interface CreateInvoiceArgs {
  subjectId: number
  // The auction currency — any ISO code, not just the deposit's CZK/EUR.
  currency: string
  amount: number
  lineName: string
  variableSymbol: string
  // The sale IS a taxable supply (unlike the VAT-0 deposit proforma) — the standard rate is a finance
  // input, passed in, never guessed in code.
  vatRate: number
  dueDays: number
  // Sale-collection IBAN → resolved to a Fakturoid bank_account_id so the document's payment
  // instructions point at the monitored Fio account.
  iban: string
}

// Regular (taxable) invoice for a settled sale. document_type:'invoice' with VAT — distinct from the
// deposit's VAT-0 proforma. Reuses the same api()/OAuth/bank-account resolution as createFakturoidProforma.
export const createFakturoidInvoice = async (args: CreateInvoiceArgs): Promise<FakturoidInvoiceResult> => {
  const bankAccountId = await resolveBankAccountId(args.iban).catch(() => null)
  if (bankAccountId == null) {
    console.warn(
      `[fakturoid] no bank account matches ${args.iban} — the invoice will show the Fakturoid account default; ` +
        'add the Fio sale accounts in Fakturoid settings',
    )
  }
  const data = await api<{
    id: number
    public_html_url: string
    variable_symbol: string
  }>('/invoices.json', {
    method: 'POST',
    body: JSON.stringify({
      document_type: 'invoice',
      subject_id: args.subjectId,
      currency: args.currency,
      payment_method: 'bank',
      variable_symbol: args.variableSymbol,
      due: args.dueDays,
      ...(bankAccountId != null ? { bank_account_id: bankAccountId } : {}),
      lines: [{ name: args.lineName, quantity: 1, unit_price: args.amount, vat_rate: args.vatRate }],
    }),
  })
  return {
    id: data.id,
    publicHtmlUrl: data.public_html_url,
    variableSymbol: data.variable_symbol,
  }
}

// Cancels a document (sibling proforma superseded by the other currency's payment)
// so it doesn't linger as an open payable invoice in Fakturoid.
export const cancelFakturoidInvoice = async (invoiceId: number): Promise<void> => {
  await api<unknown>(`/invoices/${invoiceId}/fire.json`, {
    method: 'POST',
    body: JSON.stringify({ event: 'cancel' }),
  })
}

// Records the settled bank payment so Fakturoid marks the proforma paid and thanks
// the customer. 403 means "already paid" (e.g. Fakturoid's own bank pairing won the
// race) — callers must treat it as terminal success, not retry.
export const markFakturoidInvoicePaid = async (invoiceId: number, paidOn: string, amount: number): Promise<void> => {
  await api<unknown>(`/invoices/${invoiceId}/payments.json`, {
    method: 'POST',
    body: JSON.stringify({
      paid_on: paidOn,
      amount,
      send_thank_you_email: true,
      mark_document_as_paid: true,
    }),
  })
}
