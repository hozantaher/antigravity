import {
  SALE_INVOICE_TYPE,
  computeAmountDue,
  depositCreditApplied,
  isDepositCurrency,
  settlementStateFrom,
  type Currency,
  type DepositCurrency,
  type IssueSaleTransferResult,
  type Price,
  type Settlement,
  type SettlementBankDetails,
} from '~/models'
import { COMPANY } from '~/utils/company'
import { formatPrice } from '~/utils'
import { enqueueEmail } from './emailQueue'
import {
  attachSaleFakturoidDoc,
  ensureOpenSaleInvoice,
  findSettlementCandidate,
  getSaleInvoiceItemTitle,
  listPaidSaleInvoicesPendingFakturoid,
  markSaleCompleted,
  setSaleInvoiceFakturoidPaidAt,
  type SettledSale,
} from '../repos/settlementRepo'
import { getUserForDeposit, type DepositUserRow } from '../repos/depositRepo'
import {
  FakturoidApiError,
  createFakturoidInvoice,
  createFakturoidSubject,
  isFakturoidConfigured,
  markFakturoidInvoicePaid,
} from './fakturoid'
import { buildSpayd } from './spayd'
import { getStripe, isStripeConfigured } from './stripe'
import { setUserFakturoidId } from '../repos/depositRepo'
import { addServerBreadcrumb, captureServerError } from './observability'
import type { InvoiceRow } from '../db/schema'

const SALE_INVOICE_LINE_NAME = 'Úhrada vydražené položky'
// Standard CZ VAT — a finance input parameterised here, not a per-vehicle scheme decision (v1 cut).
const SALE_VAT_RATE = 21

// Prague-date for Fakturoid paid_on (mirrors deposit.ts) — a UTC date drifts a day before midnight.
const pragueDateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' })
const pragueDate = (d: Date): string => pragueDateFormat.format(d)

// 10-digit numeric VS, first digit non-zero (leading zeros don't survive the interbank round trip —
// same constraint as generate_deposit_vs). Collision-safe enough for v1's volume; Fio match keys on
// (VS, currency, type='sale', status='unpaid'), so only OPEN sale invoices must not share a VS.
const randomSaleVs = (): string => {
  const first = 1 + Math.floor(Math.random() * 9)
  let rest = ''
  for (let i = 0; i < 9; i++) rest += Math.floor(Math.random() * 10)
  return `${first}${rest}`
}

interface SaleBankConfig {
  iban: string
  accountNumber: string
  recipient: string
}

// Bank transfer for a sale lands in the SAME monitored Fio account as the deposit (the Fio sweep
// disambiguates deposit vs sale by the invoice VS + type). So the rail is available only for the two
// monitored currencies; a non-CZK/EUR auction can't be paid by transfer (card only).
const getSaleBankConfig = (currency: DepositCurrency): SaleBankConfig => {
  const c = useRuntimeConfig()
  const iban = currency === 'CZK' ? c.depositIbanCzk : c.depositIbanEur
  const accountNumber = currency === 'CZK' ? c.depositAccountCzk : c.depositAccountEur
  if (!iban) throw createError({ statusCode: 503, statusMessage: 'Sale payments not configured' })
  return { iban, accountNumber, recipient: c.depositRecipient || COMPANY.name }
}

const buildBankDetails = (
  user: DepositUserRow,
  currency: DepositCurrency,
  amount: number,
  vs: string,
  invoiceUrl: string | null,
): SettlementBankDetails => {
  const bank = getSaleBankConfig(currency)
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
      message: `Aukce ${user.fullName}`,
    }),
    invoiceUrl,
  }
}

// Best-effort Fakturoid regular (taxable) invoice for a settled/settling sale. A Fakturoid outage
// must never block the money path — the local row carries everything Fio needs; the document is
// backfilled on the next opportunity. Mirrors ensureDepositProforma but issues document_type:'invoice'.
const ensureSaleFakturoidInvoice = async (
  invoiceId: string,
  user: DepositUserRow,
  currency: string,
  amount: number,
  vs: string,
  iban: string,
): Promise<{ id: number; url: string } | null> => {
  if (!isFakturoidConfigured()) return null
  try {
    let subjectId = user.fakturoidId
    if (!subjectId) {
      const created = await createFakturoidSubject(user)
      subjectId = await setUserFakturoidId(user.id, created)
    }
    const doc = await createFakturoidInvoice({
      subjectId,
      currency,
      amount,
      lineName: SALE_INVOICE_LINE_NAME,
      variableSymbol: vs,
      vatRate: SALE_VAT_RATE,
      dueDays: user.invoiceDueDays,
      iban,
    })
    await attachSaleFakturoidDoc(invoiceId, doc.id, doc.publicHtmlUrl)
    return { id: doc.id, url: doc.publicHtmlUrl }
  } catch (err) {
    captureServerError(err, { area: 'sale.fakturoid.invoice', tags: { invoiceId } })
    return null
  }
}

const priceFrom = (amount: string | null, code: string | null): Price => ({
  amount: amount == null ? 0 : Number(amount),
  currency: currencyFromCode(code),
})

// Local rehydration without importing the mapper (avoids a server→repo→fixtures cycle in this util):
// the currency object is only needed for display/formatPrice, and the code is the source of truth.
const currencyFromCode = (code: string | null): Currency | undefined => (code ? ({ code } as Currency) : undefined)

// Read-only (it's polled): projects the candidate into the wizard-facing Settlement state machine.
// 404 when the item or its win state isn't a settlement candidate; the winner check is the caller's
// (the handler) so this stays reusable by the cron too.
export const getSettlementStatus = async (itemId: string): Promise<Settlement> => {
  const c = await findSettlementCandidate(itemId)
  if (!c) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

  const finalPrice = priceFrom(c.finalAmount, c.finalCurrency)
  const depositHeld =
    c.depositBalanceAmount != null && Number(c.depositBalanceAmount) > 0
      ? priceFrom(c.depositBalanceAmount, c.depositBalanceCurrency)
      : undefined

  const amountDue = computeAmountDue(finalPrice, depositHeld)
  const depositCredit = depositCreditApplied(finalPrice, depositHeld)
  const state = settlementStateFrom(c.invoice?.status, c.settledAt != null)

  const settlement: Settlement = {
    itemId,
    invoiceId: c.invoice?.id ?? null,
    finalPrice,
    depositCredit,
    amountDue,
    state,
  }

  // Surface bank details only while genuinely pending an external transfer (unpaid invoice, due > 0,
  // currency monitored). amountDue === 0 settles internally, never via transfer.
  if (
    state === 'pending' &&
    c.invoice &&
    (amountDue.amount ?? 0) > 0 &&
    isDepositCurrency(c.invoice.priceCurrency ?? '') &&
    c.invoice.variableSymbol
  ) {
    const user = await getUserForDeposit(c.winnerId!)
    if (user) {
      settlement.bank = buildBankDetails(
        user,
        c.invoice.priceCurrency as DepositCurrency,
        Number(c.invoice.priceAmount ?? amountDue.amount ?? 0),
        c.invoice.variableSymbol,
        c.invoice.url,
      )
    }
  }

  return settlement
}

// Find-or-create the sale invoice for the winner and return what to render. When amountDue === 0 the
// deposit fully covers the price: the invoice is created already `paid` (single CAS) and the item is
// stamped completed — no external rail. Otherwise the unpaid invoice + bank details are returned and
// the Fio/Stripe rails settle it later. Idempotent: an existing open invoice is reused.
export const issueSaleTransfer = async (itemId: string, userId: string): Promise<IssueSaleTransferResult> => {
  const c = await findSettlementCandidate(itemId)
  if (!c) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

  const finalPrice = priceFrom(c.finalAmount, c.finalCurrency)
  const depositHeld =
    c.depositBalanceAmount != null && Number(c.depositBalanceAmount) > 0
      ? priceFrom(c.depositBalanceAmount, c.depositBalanceCurrency)
      : undefined
  const amountDue = computeAmountDue(finalPrice, depositHeld)
  const currencyCode = c.finalCurrency ?? ''

  const user = await getUserForDeposit(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  // amountDue === 0 → settle internally against the deposit credit. Create the invoice already paid
  // (the find-or-create CAS makes this exactly-once) and stamp completion. No transfer/card.
  if ((amountDue.amount ?? 0) === 0) {
    const now = new Date()
    const { invoice, created } = await ensureOpenSaleInvoice({
      itemId,
      userId,
      amount: finalPrice.amount ?? 0,
      currency: currencyCode,
      vs: randomSaleVs(),
      iban: isDepositCurrency(currencyCode) ? getSaleBankConfig(currencyCode).iban : '',
      dueDays: user.invoiceDueDays,
      paid: true,
      paidOn: now,
    })
    // Even a reused invoice may not be completed yet (crash between create-paid and stamp) — stamp now.
    const becameCompleted = await markSaleCompleted(itemId, invoice.paidAt ?? now)
    if (created || becameCompleted) {
      await finalizeSaleSettlement({
        invoiceId: invoice.id,
        userId,
        itemId,
        amount: finalPrice.amount ?? 0,
        currency: currencyCode,
        vs: invoice.variableSymbol,
        fakturoidId: invoice.fakturoidId,
        paidOn: invoice.paidAt ?? now,
        canceledSessionIds: [],
        canceledFakturoidIds: [],
      })
      await sendSalePaidEmail({
        invoiceId: invoice.id,
        userId,
        itemId,
        amount: finalPrice.amount ?? 0,
        currency: currencyCode,
        vs: invoice.variableSymbol,
        fakturoidId: invoice.fakturoidId,
        paidOn: invoice.paidAt ?? now,
        canceledSessionIds: [],
        canceledFakturoidIds: [],
      })
    }
    return { state: 'completed', amountDue }
  }

  // Transfer rail requires a monitored Fio currency.
  if (!isDepositCurrency(currencyCode)) {
    throw createError({ statusCode: 503, statusMessage: 'Sale payments not configured for this currency' })
  }
  const bank = getSaleBankConfig(currencyCode)

  const { invoice, created } = await ensureOpenSaleInvoice({
    itemId,
    userId,
    amount: amountDue.amount ?? 0,
    currency: currencyCode,
    vs: randomSaleVs(),
    iban: bank.iban,
    dueDays: user.invoiceDueDays,
  })

  let invoiceUrl = invoice.url
  if (created && !invoice.fakturoidId) {
    const doc = await ensureSaleFakturoidInvoice(
      invoice.id,
      user,
      currencyCode,
      Number(invoice.priceAmount ?? amountDue.amount ?? 0),
      invoice.variableSymbol ?? randomSaleVs(),
      bank.iban,
    )
    if (doc) invoiceUrl = doc.url
  }

  return {
    state: 'transfer',
    amountDue,
    bank: buildBankDetails(
      user,
      currencyCode,
      Number(invoice.priceAmount ?? amountDue.amount ?? 0),
      invoice.variableSymbol ?? '',
      invoiceUrl,
    ),
  }
}

// Records the settled sale on the Fakturoid document. 4xx is terminal (403 = already paid there);
// 5xx/network stays pending for the sweep. Mirrors deposit's markPaidInFakturoid.
const markSalePaidInFakturoid = async (
  invoiceId: string,
  fakturoidId: number,
  paidOn: Date,
  amount: number,
): Promise<void> => {
  try {
    await markFakturoidInvoicePaid(fakturoidId, pragueDate(paidOn), amount)
    await setSaleInvoiceFakturoidPaidAt(invoiceId)
  } catch (err) {
    if (err instanceof FakturoidApiError && err.status >= 400 && err.status < 500) {
      if (err.status !== 403) {
        captureServerError(err, { area: 'sale.fakturoid.markPaid.terminal', tags: { invoiceId } })
      }
      await setSaleInvoiceFakturoidPaidAt(invoiceId)
      return
    }
    captureServerError(err, { area: 'sale.fakturoid.markPaid', tags: { invoiceId } })
  }
}

// Post-settlement Fakturoid bookkeeping. When the invoice was never issued (Fakturoid down at settle),
// it's created now. Shared by the settle sites + the retry sweep.
const settleSaleInFakturoid = async (settled: SettledSale): Promise<void> => {
  if (!isFakturoidConfigured()) return
  let fakturoidId = settled.fakturoidId
  if (!fakturoidId) {
    const user = await getUserForDeposit(settled.userId)
    if (!user || !settled.vs || !isDepositCurrency(settled.currency)) return
    const doc = await ensureSaleFakturoidInvoice(
      settled.invoiceId,
      user,
      settled.currency,
      settled.amount,
      settled.vs,
      getSaleBankConfig(settled.currency).iban,
    )
    if (!doc) return
    fakturoidId = doc.id
  }
  await markSalePaidInFakturoid(settled.invoiceId, fakturoidId, settled.paidOn, settled.amount)
}

// A settle's superseded card sessions stay payable until expires_at — expire them (best-effort).
export const expireSaleStripeSessions = async (sessionIds: string[]): Promise<void> => {
  if (sessionIds.length === 0 || !isStripeConfigured()) return
  const stripe = getStripe()
  for (const id of sessionIds) {
    await stripe.checkout.sessions
      .expire(id)
      .catch(() => addServerBreadcrumb('sale stripe session expire skipped', { id }))
  }
}

// The one post-settle side-effect pipeline (Fio + Stripe + sweep all go through here): kill superseded
// payment vectors, then do the Fakturoid bookkeeping. Best-effort — the sale is settled and stays
// settled. The completion stamp is set at the settle site (markSaleCompleted), not here, so the sweep
// re-running this on an already-paid invoice can't re-fire completion side-effects.
export const finalizeSaleSettlement = async (settled: SettledSale): Promise<void> => {
  await expireSaleStripeSessions(settled.canceledSessionIds)
  try {
    await settleSaleInFakturoid(settled)
  } catch (err) {
    captureServerError(err, { area: 'sale.fakturoid.settle', tags: { invoiceId: settled.invoiceId } })
  }
}

// Branded "sale paid" confirmation. Best-effort, dedup-keyed on the invoice so the settle CAS (which
// makes the genuine settle sites fire once) guarantees one email per real settle.
export const sendSalePaidEmail = async (settled: SettledSale): Promise<void> => {
  try {
    const user = await getUserForDeposit(settled.userId)
    if (!user?.email) return
    const itemTitle = settled.itemId ? await getSaleInvoiceItemTitle(settled.itemId) : undefined
    const baseUrl = useRuntimeConfig().public.baseUrl
    await enqueueEmail(
      {
        recipient: user.email,
        templateKey: 'salePaid',
        language: user.languageCode ?? 'cz',
        params: {
          itemTitle: itemTitle ?? '',
          saleAmount: formatPrice({ amount: settled.amount, currency: currencyFromCode(settled.currency) }),
          itemUrl: settled.itemId ? `${baseUrl}/item/${settled.itemId}` : baseUrl,
        },
      },
      { dedupKey: `sale-paid:${settled.invoiceId}` },
    )
  } catch (err) {
    captureServerError(err, { area: 'sale.email.paid', tags: { invoiceId: settled.invoiceId } })
  }
}

// Retry sweep: paid sale invoices whose Fakturoid bookkeeping is incomplete. Mirrors the deposit sweep.
export const sweepSaleFakturoidPending = async (): Promise<void> => {
  if (!isFakturoidConfigured()) return
  try {
    const pending = await listPaidSaleInvoicesPendingFakturoid()
    for (const invoice of pending) {
      await finalizeSaleSettlement({
        invoiceId: invoice.id,
        userId: invoice.userId,
        itemId: null,
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
    captureServerError(err, { area: 'sale.fakturoid.sweep' })
  }
}

// Stripe Checkout amount/currency/VS for the sale invoice — used by the checkout endpoint to build
// the session line item and metadata. Returns the open sale invoice (find-or-create), guaranteeing
// transfer + card pay against the SAME local invoice.
export const prepareSaleCheckout = async (
  itemId: string,
  userId: string,
): Promise<{ invoice: InvoiceRow; amountDue: number; currency: string }> => {
  const c = await findSettlementCandidate(itemId)
  if (!c) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

  const finalPrice = priceFrom(c.finalAmount, c.finalCurrency)
  const depositHeld =
    c.depositBalanceAmount != null && Number(c.depositBalanceAmount) > 0
      ? priceFrom(c.depositBalanceAmount, c.depositBalanceCurrency)
      : undefined
  const amountDue = computeAmountDue(finalPrice, depositHeld)
  const currencyCode = c.finalCurrency ?? ''
  if ((amountDue.amount ?? 0) === 0) {
    throw createError({ statusCode: 409, statusMessage: 'Sale already covered by deposit' })
  }

  const user = await getUserForDeposit(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  const { invoice } = await ensureOpenSaleInvoice({
    itemId,
    userId,
    amount: amountDue.amount ?? 0,
    currency: currencyCode,
    vs: randomSaleVs(),
    iban: isDepositCurrency(currencyCode) ? getSaleBankConfig(currencyCode).iban : '',
    dueDays: user.invoiceDueDays,
  })

  return { invoice, amountDue: Number(invoice.priceAmount ?? amountDue.amount ?? 0), currency: currencyCode }
}

// SALE_VAT_RATE is exported for the OpenAPI docs / tests that assert the rate is a single source.
export { SALE_VAT_RATE, SALE_INVOICE_TYPE }
