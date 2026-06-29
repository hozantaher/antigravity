import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { INVOICE_STATUS, SALE_INVOICE_TYPE } from '~/models'
import { db } from '../utils/db'
import type { Database, InvoiceRow } from '../db/schema'
import { settleInvoiceInTx as settleCore, type SettleColumns, type SettleCoreResult } from './settleCore'

// ---- Pure invariant gate ---------------------------------------------------

export interface SettlementContext {
  // The viewer asking to settle.
  userId: string
  // The item being settled.
  sold: boolean
  closed: boolean
  winnerId: string | null
  // Already-paid sale invoice? (the durable completion marker or a paid invoice)
  alreadyCompleted: boolean
}

export type SettlementRejection =
  | { status: 403; code: 'not_winner' }
  | { status: 404; code: 'not_sold' }
  | { status: 409; code: 'already_settled' }

// The single settlement-eligibility predicate (mirrors itemRepo.bidError). Only the auction winner of
// a sold+closed item may settle, and only while it isn't already settled. Pure → unit-testable and
// reused by the status/transfer/checkout handlers so the rule can't drift between them.
export const settlementError = (c: SettlementContext): SettlementRejection | null => {
  if (!c.sold || !c.closed || !c.winnerId) return { status: 404, code: 'not_sold' }
  if (c.winnerId !== c.userId) return { status: 403, code: 'not_winner' }
  if (c.alreadyCompleted) return { status: 409, code: 'already_settled' }
  return null
}

// ---- Candidate read --------------------------------------------------------

export interface SettlementCandidate {
  itemId: string
  sold: boolean
  closed: boolean
  winnerId: string | null
  settledAt: Date | null
  settlementInvoiceId: string | null
  // The winning bid = the newest bid on the item (the final price).
  finalAmount: string | null
  finalCurrency: string | null
  // The linked sale invoice, if one exists.
  invoice: InvoiceRow | undefined
  // The winner's deposit balance (to offset).
  depositBalanceAmount: string | null
  depositBalanceCurrency: string | null
}

// Joins the item + its newest bid + the linked sale invoice + the winner's deposit balance. Used by
// the status endpoint and the orchestration layer; returns undefined when the item doesn't exist.
export const findSettlementCandidate = async (itemId: string): Promise<SettlementCandidate | undefined> => {
  const item = await db
    .selectFrom('items')
    .select(['id', 'sold', 'closed', 'winner', 'settledAt', 'settlementInvoiceId'])
    .where('id', '=', itemId)
    .executeTakeFirst()
  if (!item) return undefined

  const winnerId = item.winner?.id ?? null

  const [finalBid, invoice, winner] = await Promise.all([
    db
      .selectFrom('bids')
      .select(['amount', 'currencyCode'])
      .where('itemId', '=', itemId)
      .orderBy('date', 'desc')
      .limit(1)
      .executeTakeFirst(),
    item.settlementInvoiceId
      ? db.selectFrom('invoices').selectAll().where('id', '=', item.settlementInvoiceId).executeTakeFirst()
      : Promise.resolve(undefined),
    winnerId
      ? db
          .selectFrom('users')
          .select(['depositBalanceAmount', 'depositBalanceCurrency'])
          .where('id', '=', winnerId)
          .executeTakeFirst()
      : Promise.resolve(undefined),
  ])

  return {
    itemId: item.id,
    sold: item.sold,
    closed: item.closed,
    winnerId,
    settledAt: item.settledAt,
    settlementInvoiceId: item.settlementInvoiceId,
    finalAmount: finalBid?.amount ?? null,
    finalCurrency: finalBid?.currencyCode ?? null,
    invoice,
    depositBalanceAmount: winner?.depositBalanceAmount ?? null,
    depositBalanceCurrency: winner?.depositBalanceCurrency ?? null,
  }
}

// ---- Find-or-create the sale invoice (claim CAS) ---------------------------

export interface RecordSaleInvoiceInput {
  itemId: string
  userId: string
  amount: number
  currency: string
  vs: string
  iban: string
  dueDays: number
  // Create the invoice already `paid` (amountDue === 0, fully covered by the deposit) — settled
  // against the deposit credit with no external rail. Default unpaid.
  paid?: boolean
  paidOn?: Date
}

export interface OpenSaleInvoiceResult {
  invoice: InvoiceRow
  // True when this call created the invoice (vs reused an existing linked one) — lets the caller fire
  // the best-effort Fakturoid issuance only once.
  created: boolean
}

// Find-or-create the single type='sale' invoice for an item and link it on items.settlement_invoice_id,
// all in ONE transaction. The item row is locked FOR UPDATE first so two concurrent "start settlement"
// callers serialize: the first creates + links the invoice, the second sees the link and reuses it —
// exactly one sale invoice per item (charge-once invariant I1; the partial unique index is the
// backstop). A crash before commit rolls back both the insert and the link, so a retry is clean.
export const ensureOpenSaleInvoice = async (input: RecordSaleInvoiceInput): Promise<OpenSaleInvoiceResult> =>
  db.transaction().execute(async trx => {
    const locked = await trx
      .selectFrom('items')
      .select(['id', 'settlementInvoiceId'])
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst()
    if (!locked) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

    if (locked.settlementInvoiceId) {
      const existing = await trx
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', locked.settlementInvoiceId)
        .executeTakeFirst()
      // A canceled link should have been cleared; if the row is missing fall through to re-create.
      if (existing) return { invoice: existing, created: false }
    }

    const now = new Date()
    const paid = input.paid === true
    // Snapshot the payer's billing address as it is now (both the card-checkout and bank-transfer
    // paths funnel through here), so the invoice document keeps it even if the profile later changes.
    const payer = await trx.selectFrom('users').select('address').where('id', '=', input.userId).executeTakeFirst()
    const invoice = await trx
      .insertInto('invoices')
      .values({
        id: randomUUID(),
        userId: input.userId,
        createdDate: now,
        invoiceCreatedDate: now,
        invoiceDueDate: new Date(now.getTime() + input.dueDays * 86_400_000),
        paidAt: paid ? (input.paidOn ?? now) : null,
        status: paid ? INVOICE_STATUS.paid : INVOICE_STATUS.unpaid,
        priceAmount: input.amount,
        priceCurrency: input.currency,
        url: null,
        variableSymbol: input.vs,
        iban: input.iban,
        billingAddress: payer?.address ?? null,
        type: SALE_INVOICE_TYPE,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // Claim the slot. The FOR UPDATE lock above means this can't lose the race; the WHERE …IS NULL is
    // a defensive backstop matching the partial unique index.
    await trx
      .updateTable('items')
      .set({ settlementInvoiceId: invoice.id })
      .where('id', '=', input.itemId)
      .where('settlementInvoiceId', 'is', null)
      .execute()

    return { invoice, created: true }
  })

export const attachSaleFakturoidDoc = async (invoiceId: string, fakturoidId: number, url: string): Promise<void> => {
  await db.updateTable('invoices').set({ fakturoidId, url }).where('id', '=', invoiceId).execute()
}

export const setSaleInvoiceStripeSession = async (invoiceId: string, sessionId: string): Promise<void> => {
  await db.updateTable('invoices').set({ stripeSessionId: sessionId }).where('id', '=', invoiceId).execute()
}

// ---- Settle (shared core, type='sale', no sibling-cancel) ------------------

export interface SettledSale extends SettleCoreResult {
  // The item this sale invoice settles (for the completion stamp + email dedup).
  itemId: string | null
}

const settleSaleInTx = async (
  trx: Kysely<Database>,
  invoice: InvoiceRow,
  paidAmount: number,
  paidOn: Date,
  set: SettleColumns,
  extraSessionIds: (string | null)[],
): Promise<SettledSale | null> => {
  // Sales NEVER cancel siblings — a user can win many items, each its own independent sale invoice.
  // No deposit-balance write either: a sale doesn't touch the deposit balance (the offset already
  // happened at amountDue time). So afterSettle is omitted.
  const core = await settleCore(trx, invoice, paidAmount, paidOn, set, extraSessionIds, {
    type: SALE_INVOICE_TYPE,
    cancelSiblings: false,
  })
  if (!core) return null

  const item = await trx
    .selectFrom('items')
    .select('id')
    .where('settlementInvoiceId', '=', invoice.id)
    .executeTakeFirst()
  return { ...core, itemId: item?.id ?? null }
}

export interface FioSaleSettleInput {
  account: 'CZK' | 'EUR'
  fioId: string
  amount: number
  currency: string
  vs: string | null
  paidOn: Date
}

export interface FioSaleSettleResult {
  settled: SettledSale | null
}

// Settle a matched bank transfer against a type='sale' invoice. The Fio MOVEMENT itself is already
// claimed by the deposit sweep's settleFioPayment (shared (account, fio_id) dedupe); this runs only
// after the deposit match missed, so it just needs the charge-once invoice CAS. VS match is
// zero-insensitive (banks strip leading zeros).
export const settleSaleFioPayment = async (p: FioSaleSettleInput): Promise<FioSaleSettleResult> =>
  db.transaction().execute(async trx => {
    const vsKey = p.vs?.replace(/^0+/, '') ?? ''
    if (!vsKey) return { settled: null }

    const invoice = await trx
      .selectFrom('invoices')
      .selectAll()
      .where(sql<string>`ltrim(variable_symbol, '0')`, '=', vsKey)
      .where('priceCurrency', '=', p.currency)
      .where('type', '=', SALE_INVOICE_TYPE)
      .where('status', '=', INVOICE_STATUS.unpaid)
      .orderBy('createdDate', 'asc')
      .executeTakeFirst()
    if (!invoice) return { settled: null }

    // The bank transfer won — an open card session for THIS invoice (cross-method race) must die too.
    const settled = await settleSaleInTx(trx, invoice, p.amount, p.paidOn, {}, [invoice.stripeSessionId])
    return { settled }
  })

export interface StripeSaleInput {
  userId: string
  invoiceId: string | null
  currency: string
  amount: number
  sessionId: string
  paymentIntent: string | null
}

export type StripeSaleOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'already_settled' }
  | { outcome: 'unmatched' }
  | { outcome: 'settled'; settled: SettledSale }

// Webhook claim + settle in ONE transaction (reuses the shared processed_stripe_events claim table —
// it is not deposit-scoped). A throw rolls the claim back so Stripe redelivery re-runs; terminal
// outcomes commit the claim and stop the retry loop. Mirrors processStripeDeposit's cross-rail logic:
// a session id already on a PAID invoice WITH a payment intent is a replay (already_settled); the
// same id on a Fio-settled invoice (no payment intent) is a real double charge → unmatched (refund
// candidate). No fallback to "the user's open invoice": a sale invoice is item-scoped and must match
// by its own id, never by guessing another of the user's invoices.
export const processStripeSale = async (
  eventId: string,
  eventType: string,
  data: StripeSaleInput,
  paidOn: Date,
): Promise<StripeSaleOutcome> =>
  db.transaction().execute(async trx => {
    const claim = await trx
      .insertInto('processedStripeEvents')
      .values({ eventId, type: eventType })
      .onConflict(oc => oc.column('eventId').doNothing())
      .returning('eventId')
      .executeTakeFirst()
    if (!claim) return { outcome: 'duplicate' }

    const set: SettleColumns = { stripeSessionId: data.sessionId, stripePaymentIntent: data.paymentIntent }

    let settled: SettledSale | null = null
    if (data.invoiceId) {
      const invoice = await trx
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', data.invoiceId)
        .where('userId', '=', data.userId)
        .where('type', '=', SALE_INVOICE_TYPE)
        .where('status', '=', INVOICE_STATUS.unpaid)
        .executeTakeFirst()
      if (invoice && invoice.priceCurrency === data.currency) {
        settled = await settleSaleInTx(trx, invoice, data.amount, paidOn, set, [])
      }
    }

    if (!settled) {
      // Replay of a settle we already recorded? Only a Stripe settle writes the payment intent — a
      // Fio-settled invoice carrying this session id is a REAL cross-method double charge.
      const existing = await trx
        .selectFrom('invoices')
        .select(['status', 'stripePaymentIntent'])
        .where('stripeSessionId', '=', data.sessionId)
        .where('type', '=', SALE_INVOICE_TYPE)
        .executeTakeFirst()
      if (existing?.status === INVOICE_STATUS.paid && existing.stripePaymentIntent) {
        return { outcome: 'already_settled' }
      }
      return { outcome: 'unmatched' }
    }

    return { outcome: 'settled', settled }
  })

// ---- Complete-once stamp ---------------------------------------------------

// Stamp the item's "sale completed" marker under a WHERE settled_at IS NULL CAS, so the completion
// side-effects (email, terminal UI) fire exactly once even if multiple rails report the settle. Runs
// in its own statement after the settle commits. Returns true only on the transition.
export const markSaleCompleted = async (itemId: string, settledOn: Date): Promise<boolean> => {
  const updated = await db
    .updateTable('items')
    .set({ settledAt: settledOn })
    .where('id', '=', itemId)
    .where('settledAt', 'is', null)
    .returning('id')
    .executeTakeFirst()
  return updated != null
}

// Paid sale invoices whose Fakturoid bookkeeping is incomplete — both mark-paid failures AND invoices
// whose document was never issued (Fakturoid down at settle). Oldest first so a permanently failing
// row can't starve newer ones. Mirrors listPaidInvoicesPendingFakturoid for the deposit sweep.
export interface FakturoidPendingSale {
  id: string
  userId: string
  fakturoidId: number | null
  paidAt: Date | null
  priceAmount: string | null
  priceCurrency: string | null
  variableSymbol: string | null
}

export const listPaidSaleInvoicesPendingFakturoid = async (limit = 20): Promise<FakturoidPendingSale[]> =>
  db
    .selectFrom('invoices')
    .select(['id', 'userId', 'fakturoidId', 'paidAt', 'priceAmount', 'priceCurrency', 'variableSymbol'])
    .where('type', '=', SALE_INVOICE_TYPE)
    .where('status', '=', INVOICE_STATUS.paid)
    .where('fakturoidPaidAt', 'is', null)
    .orderBy('paidAt', 'asc')
    .limit(limit)
    .execute()

export const setSaleInvoiceFakturoidPaidAt = async (invoiceId: string): Promise<void> => {
  await db.updateTable('invoices').set({ fakturoidPaidAt: new Date() }).where('id', '=', invoiceId).execute()
}

// The winner's billing/identity for the Fakturoid sale invoice. Mirrors DepositUserRow's shape so the
// shared createFakturoidSubject works unchanged.
export const getSaleInvoiceItemTitle = async (itemId: string): Promise<string | undefined> => {
  const row = await db.selectFrom('items').select('title').where('id', '=', itemId).executeTakeFirst()
  return row?.title
}
