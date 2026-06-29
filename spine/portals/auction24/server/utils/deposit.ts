import type { DepositBankDetails, DepositCurrency, DepositStatus } from '~/models'
import { depositAmountFor, isDepositCurrency } from '~/models'
import { COMPANY } from '~/utils/company'
import { formatDepositAmount } from '~/utils'
import { enqueueEmail } from './emailQueue'
import {
  attachFakturoidDoc,
  findAnyOpenDepositInvoice,
  findOpenDepositInvoice,
  getUserForDeposit,
  listPaidInvoicesPendingFakturoid,
  loadProcessedFioIds,
  pruneProcessedStripeEvents,
  recordDepositInvoice,
  setInvoiceFakturoidPaidAt,
  setUserFakturoidId,
  settleFioPayment,
  type DepositUserRow,
  type SettledDeposit,
} from '../repos/depositRepo'
import {
  FakturoidApiError,
  cancelFakturoidInvoice,
  createFakturoidProforma,
  createFakturoidSubject,
  isFakturoidConfigured,
  markFakturoidInvoicePaid,
} from './fakturoid'
import { fetchFioTransactions } from './fio'
import { buildSpayd } from './spayd'
import { getStripe, isStripeConfigured } from './stripe'
import { addServerBreadcrumb, captureServerError } from './observability'
import { finalizeSaleSettlement, sendSalePaidEmail, sweepSaleFakturoidPending } from './settlement'
import { markSaleCompleted, settleSaleFioPayment } from '../repos/settlementRepo'
import type { InvoiceRow } from '../db/schema'

const DEPOSIT_INVOICE_LINE_NAME = 'Vratná kauce pro přístup k aukcím'
const DEPOSIT_VAT_RATE = 0
const FIO_WINDOW_DAYS = 7

// Fio books movements (and Fakturoid expects paid_on) in Europe/Prague dates — a UTC
// date is yesterday between Prague midnight and UTC midnight and would hide fresh
// payments from the fetch window. en-CA formats as YYYY-MM-DD.
const pragueDateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' })
const pragueDate = (d: Date): string => pragueDateFormat.format(d)

interface DepositBankConfig {
  iban: string
  accountNumber: string
  recipient: string
}

const getDepositBankConfig = (currency: DepositCurrency): DepositBankConfig => {
  const c = useRuntimeConfig()
  const iban = currency === 'CZK' ? c.depositIbanCzk : c.depositIbanEur
  const accountNumber = currency === 'CZK' ? c.depositAccountCzk : c.depositAccountEur
  if (!iban) throw createError({ statusCode: 503, statusMessage: 'Deposit payments not configured' })
  return { iban, accountNumber, recipient: c.depositRecipient || COMPANY.name }
}

// Best-effort Fakturoid proforma for an existing local invoice. A Fakturoid outage
// must never block the payment flow — the local row carries everything Fio matching
// needs; the document is backfilled here on the next opportunity.
const ensureDepositProforma = async (
  invoiceId: string,
  user: DepositUserRow,
  currency: DepositCurrency,
  amount: number,
  vs: string,
): Promise<{ id: number; url: string } | null> => {
  if (!isFakturoidConfigured()) return null
  try {
    let subjectId = user.fakturoidId
    if (!subjectId) {
      const created = await createFakturoidSubject(user)
      // Adopt the persisted winner — a lost race must not issue documents under an
      // orphan duplicate subject.
      subjectId = await setUserFakturoidId(user.id, created)
    }
    const doc = await createFakturoidProforma({
      subjectId,
      currency,
      amount,
      lineName: DEPOSIT_INVOICE_LINE_NAME,
      variableSymbol: vs,
      vatRate: DEPOSIT_VAT_RATE,
      dueDays: user.invoiceDueDays,
      // Pins the document's payment instructions to the monitored Fio account —
      // without it Fakturoid renders the account default and payments made per the
      // proforma would land where the cron never looks.
      iban: getDepositBankConfig(currency).iban,
    })
    await attachFakturoidDoc(invoiceId, doc.id, doc.publicHtmlUrl)
    return { id: doc.id, url: doc.publicHtmlUrl }
  } catch (err) {
    captureServerError(err, { area: 'deposit.fakturoid.proforma', tags: { invoiceId } })
    return null
  }
}

const hasPaidDepositRow = (user: DepositUserRow): boolean =>
  !user.depositRequired || Number(user.depositBalanceAmount ?? 0) > 0

const bankDetailsFor = (
  user: DepositUserRow,
  currency: DepositCurrency,
  amount: number,
  vs: string,
  invoiceUrl: string | null,
): DepositBankDetails => {
  const bank = getDepositBankConfig(currency)
  return {
    iban: bank.iban,
    accountNumber: bank.accountNumber,
    recipient: bank.recipient,
    vs,
    amount,
    currency,
    spayd: buildSpayd({
      iban: bank.iban,
      amount,
      currency,
      vs,
      recipient: bank.recipient,
      message: `Kauce ${user.fullName}`,
    }),
    invoiceUrl,
  }
}

export interface OpenDepositContext {
  user: DepositUserRow
  invoice: InvoiceRow
}

// Fresh-read eligibility gate + find-or-create of the local open invoice. Shared by
// the transfer and card-checkout endpoints so both methods pay against the same
// document (and the settle paths stay uniform).
export const ensureOpenDepositInvoice = async (
  userId: string,
  currency: DepositCurrency,
): Promise<OpenDepositContext> => {
  const user = await getUserForDeposit(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })
  // Fresh read (not the cached session) — guards the cron→init race where the
  // deposit was just settled, so we don't issue an invoice for an already-paid user.
  if (hasPaidDepositRow(user)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Deposit already paid',
      data: { code: 'deposit_already_paid' },
    })
  }

  const bank = getDepositBankConfig(currency)
  let invoice = await findOpenDepositInvoice(userId, currency)
  if (!invoice) {
    invoice = await recordDepositInvoice({
      userId,
      amount: depositAmountFor(currency),
      currency,
      vs: user.depositVs,
      iban: bank.iban,
      dueDays: user.invoiceDueDays,
    })
  }
  return { user, invoice }
}

// Issues (or reuses) the unpaid deposit invoice for the chosen currency and returns
// the payment details the wizard renders.
export const issueDepositTransfer = async (userId: string, currency: DepositCurrency): Promise<DepositBankDetails> => {
  const { user, invoice } = await ensureOpenDepositInvoice(userId, currency)

  const amount = Number(invoice.priceAmount ?? depositAmountFor(currency))
  const vs = invoice.variableSymbol ?? user.depositVs
  let invoiceUrl = invoice.url
  if (!invoice.fakturoidId) {
    const doc = await ensureDepositProforma(invoice.id, user, currency, amount, vs)
    if (doc) invoiceUrl = doc.url
  }

  return bankDetailsFor(user, currency, amount, vs, invoiceUrl)
}

// Read-only (it's polled): paid → balance, pending → open invoice details, else none.
export const getDepositStatus = async (userId: string): Promise<DepositStatus> => {
  const user = await getUserForDeposit(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  if (hasPaidDepositRow(user)) {
    const balance = Number(user.depositBalanceAmount ?? 0)
    return {
      state: 'paid',
      // Exempt users (depositRequired=false, nothing paid) get no amount — rendering
      // "deposit paid: 0 €" would misstate their state.
      paid: balance > 0 ? { amount: balance, currency: user.depositBalanceCurrency ?? 'EUR' } : undefined,
    }
  }

  const open = await findAnyOpenDepositInvoice(userId)
  if (!open || open.priceAmount == null || !open.priceCurrency || !isDepositCurrency(open.priceCurrency)) {
    return { state: 'none' }
  }

  const vs = open.variableSymbol ?? user.depositVs
  return {
    state: 'pending',
    pending: bankDetailsFor(user, open.priceCurrency, Number(open.priceAmount), vs, open.url),
  }
}

// Records the settled payment on the Fakturoid document. Any 4xx is terminal for
// this document (403 = already paid there — its bank pairing won; 404 = deleted in
// the Fakturoid UI; 422 = rejected) — stamp it so the sweep stops retrying forever.
// 5xx/network errors stay pending and the sweep retries on the next cron run.
const markPaidInFakturoid = async (
  invoiceId: string,
  fakturoidId: number,
  paidOn: Date,
  amount: number,
): Promise<void> => {
  try {
    await markFakturoidInvoicePaid(fakturoidId, pragueDate(paidOn), amount)
    await setInvoiceFakturoidPaidAt(invoiceId)
  } catch (err) {
    if (err instanceof FakturoidApiError && err.status >= 400 && err.status < 500) {
      if (err.status !== 403) {
        captureServerError(err, { area: 'deposit.fakturoid.markPaid.terminal', tags: { invoiceId } })
      }
      await setInvoiceFakturoidPaidAt(invoiceId)
      return
    }
    captureServerError(err, { area: 'deposit.fakturoid.markPaid', tags: { invoiceId } })
  }
}

// Post-settlement Fakturoid bookkeeping. When the proforma never got issued
// (Fakturoid was down at transfer time), it's created now so the paid document exists.
// Shared by the Fio cron, the Stripe webhook, and the retry sweep.
export const settleInFakturoid = async (settled: SettledDeposit): Promise<void> => {
  if (!isFakturoidConfigured()) return
  let fakturoidId = settled.fakturoidId
  if (!fakturoidId) {
    const user = await getUserForDeposit(settled.userId)
    if (!user || !settled.vs || !isDepositCurrency(settled.currency)) return
    const doc = await ensureDepositProforma(settled.invoiceId, user, settled.currency, settled.amount, settled.vs)
    if (!doc) return
    fakturoidId = doc.id
  }
  await markPaidInFakturoid(settled.invoiceId, fakturoidId, settled.paidOn, settled.amount)
}

// A settle cancels sibling invoices, but their Stripe Checkout sessions stay payable
// until expires_at — expire them so the user can't complete a second payment.
// Best-effort: an already-completed/expired session just logs a breadcrumb.
export const expireStripeSessions = async (sessionIds: string[]): Promise<void> => {
  if (sessionIds.length === 0 || !isStripeConfigured()) return
  const stripe = getStripe()
  for (const id of sessionIds) {
    await stripe.checkout.sessions.expire(id).catch(() => addServerBreadcrumb('stripe session expire skipped', { id }))
  }
}

// Cancels the canceled siblings' Fakturoid proformas — they were issued with bank
// details + VS (possibly e-mailed) and would otherwise stay open payable documents.
const cancelSiblingProformas = async (fakturoidIds: number[]): Promise<void> => {
  if (fakturoidIds.length === 0 || !isFakturoidConfigured()) return
  for (const id of fakturoidIds) {
    await cancelFakturoidInvoice(id).catch(err =>
      captureServerError(err, { area: 'deposit.fakturoid.cancelSibling', tags: { fakturoidId: String(id) } }),
    )
  }
}

// The one post-settle side-effect pipeline (Fio cron + Stripe webhook + sweep all go
// through here): kill superseded payment vectors, then do the Fakturoid bookkeeping.
// Entirely best-effort — the deposit is already settled and must stay settled.
export const finalizeDepositSettlement = async (settled: SettledDeposit): Promise<void> => {
  await expireStripeSessions(settled.canceledSessionIds)
  await cancelSiblingProformas(settled.canceledFakturoidIds)
  try {
    await settleInFakturoid(settled)
  } catch (err) {
    captureServerError(err, { area: 'deposit.fakturoid.settle', tags: { invoiceId: settled.invoiceId } })
  }
}

// Branded, recipient-localized "deposit received" confirmation. Best-effort and fired
// only at the two genuine settle sites (Fio match + Stripe webhook), never from the
// shared finalize pipeline — the Fakturoid retry sweep re-runs that on already-paid
// invoices and would resend on every cron run. The settle CAS makes those sites fire
// exactly once per real settle, so no dedup flag is needed.
export const sendDepositPaidEmail = async (settled: SettledDeposit): Promise<void> => {
  try {
    const user = await getUserForDeposit(settled.userId)
    if (!user?.email) return
    const baseUrl = useRuntimeConfig().public.baseUrl
    await enqueueEmail(
      {
        recipient: user.email,
        templateKey: 'depositPaid',
        language: user.languageCode ?? 'cz',
        params: {
          depositAmount: formatDepositAmount(settled.amount, settled.currency),
          billingUrl: `${baseUrl}/profile/billing`,
        },
      },
      { dedupKey: `deposit-paid:${settled.invoiceId}` },
    )
  } catch (err) {
    captureServerError(err, { area: 'deposit.email.paid', tags: { invoiceId: settled.invoiceId } })
  }
}

// Retry sweep: paid deposits whose Fakturoid bookkeeping is incomplete — both
// mark-paid failures AND invoices whose proforma never got issued at all.
const sweepFakturoidPending = async (): Promise<void> => {
  if (!isFakturoidConfigured()) return
  try {
    const pending = await listPaidInvoicesPendingFakturoid()
    for (const invoice of pending) {
      await finalizeDepositSettlement({
        invoiceId: invoice.id,
        userId: invoice.userId,
        amount: Number(invoice.priceAmount ?? 0),
        currency: invoice.priceCurrency ?? '',
        vs: invoice.variableSymbol,
        fakturoidId: invoice.fakturoidId,
        paidOn: invoice.paidAt ?? new Date(),
        canceledSessionIds: [],
        canceledFakturoidIds: [],
      })
    }
  } catch (err) {
    captureServerError(err, { area: 'deposit.fakturoid.sweep' })
  }
}

// Attempt to settle a Fio movement (already claimed by the deposit path) against a SALE invoice.
// On a real settle: stamp the item completed (CAS, once) + run the best-effort finalize + email.
// Returns true iff a sale invoice was settled. Errors are logged, not thrown (per-movement isolation).
const settleSaleFioMatch = async (p: {
  account: 'CZK' | 'EUR'
  fioId: string
  amount: number
  currency: string
  vs: string | null
  paidOn: Date
}): Promise<boolean> => {
  try {
    const { settled } = await settleSaleFioPayment(p)
    if (!settled) return false
    if (Math.round(p.amount * 100) > Math.round(settled.amount * 100)) {
      addServerBreadcrumb('sale overpaid', {
        account: p.account,
        fioId: p.fioId,
        paid: p.amount,
        required: settled.amount,
      })
    }
    if (settled.itemId) await markSaleCompleted(settled.itemId, settled.paidOn)
    await finalizeSaleSettlement(settled)
    await sendSalePaidEmail(settled)
    return true
  } catch (err) {
    captureServerError(err, { area: 'sale.fio.process', tags: { account: p.account, fioId: p.fioId } })
    return false
  }
}

export interface FioRunResult {
  matched: number
  unmatched: number
  errors: number
  skipped: string[]
}

// Cron entry: pulls a sliding window of movements from both Fio accounts and settles
// matches. Claim + settle are one transaction (settleFioPayment), so a failure mid-
// payment is retried by the next run instead of stranding the money. Per-item
// try/catch — one bad movement never aborts the batch. Fully idempotent.
export const processFioPayments = async (): Promise<FioRunResult> => {
  const c = useRuntimeConfig()
  const accounts = [
    { account: 'CZK' as const, token: c.fioTokenCzk },
    { account: 'EUR' as const, token: c.fioTokenEur },
  ]
  const result: FioRunResult = { matched: 0, unmatched: 0, errors: 0, skipped: [] }
  const now = new Date()
  const from = pragueDate(new Date(now.getTime() - FIO_WINDOW_DAYS * 86_400_000))
  const to = pragueDate(now)

  for (const { account, token } of accounts) {
    if (!token) {
      result.skipped.push(`${account}:unconfigured`)
      continue
    }

    let transactions
    try {
      transactions = await fetchFioTransactions(token, from, to)
    } catch (err) {
      captureServerError(err, { area: 'deposit.fio.fetch', tags: { account } })
      result.errors++
      continue
    }
    if (transactions === null) {
      // Fio's 30s throttle — the next run re-covers the window.
      addServerBreadcrumb('fio throttled', { account })
      result.skipped.push(`${account}:throttled`)
      continue
    }

    // The window re-covers movements already settled on earlier runs; skip those up front with one
    // SELECT instead of reopening a claim transaction per movement. settleFioPayment's (account,
    // fio_id) dedupe stays authoritative — this is purely an optimization (no behavior change). A
    // failure here must NOT abort the run: degrade to the empty set so the settle loop proceeds
    // exactly as before (the dedupe still prevents double-processing).
    const candidateIds = transactions.filter(tx => tx.amount > 0 && tx.currency === account).map(tx => tx.id)
    const processed = await loadProcessedFioIds(account, candidateIds).catch(err => {
      captureServerError(err, { area: 'deposit.fio.prefilter', tags: { account } })
      return new Set<string>()
    })

    for (const tx of transactions) {
      if (tx.amount <= 0 || tx.currency !== account || processed.has(tx.id)) continue
      try {
        const { claimed, settled } = await settleFioPayment({
          account,
          fioId: tx.id,
          amount: tx.amount,
          currency: tx.currency,
          vs: tx.vs,
          counterAccount:
            tx.counterAccount && tx.counterBankCode ? `${tx.counterAccount}/${tx.counterBankCode}` : tx.counterAccount,
          counterName: tx.counterName,
          message: tx.message,
          paidOn: tx.date ? new Date(`${tx.date}T00:00:00Z`) : now,
          raw: tx.raw,
        })
        if (!claimed) continue

        if (!settled) {
          // The movement claim lives in the deposit path (settleFioPayment), so a deposit miss is the
          // single place to also try a SALE invoice match before declaring the money unmatched. The
          // VS disambiguates: a sale invoice carries its own unique VS, distinct from deposit VS.
          const saleSettled = await settleSaleFioMatch({
            account,
            fioId: tx.id,
            amount: tx.amount,
            currency: tx.currency,
            vs: tx.vs,
            paidOn: tx.date ? new Date(`${tx.date}T00:00:00Z`) : now,
          })
          if (saleSettled) {
            result.matched++
            continue
          }

          result.unmatched++
          // Money arrived that we couldn't attribute — an ops signal, not an exception.
          captureServerError(
            new Error(
              `Unmatched deposit payment ${account}/${tx.id} (vs=${tx.vs ?? '—'}, ${tx.amount} ${tx.currency})`,
            ),
            {
              area: 'deposit.fio.unmatched',
              tags: { account, fioId: tx.id },
            },
          )
          continue
        }

        result.matched++
        if (Math.round(tx.amount * 100) > Math.round(settled.amount * 100)) {
          addServerBreadcrumb('deposit overpaid', { account, fioId: tx.id, paid: tx.amount, required: settled.amount })
        }
        await finalizeDepositSettlement(settled)
        await sendDepositPaidEmail(settled)
      } catch (err) {
        captureServerError(err, { area: 'deposit.fio.process', tags: { account, fioId: tx.id } })
        result.errors++
      }
    }
  }

  await sweepFakturoidPending()
  await sweepSaleFakturoidPending()
  await pruneProcessedStripeEvents().catch(() => addServerBreadcrumb('stripe events prune skipped'))
  return result
}
