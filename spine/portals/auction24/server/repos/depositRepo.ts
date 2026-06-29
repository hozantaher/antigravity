import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { DepositCurrency } from '~/models'
import { DEPOSIT_INVOICE_TYPE, INVOICE_STATUS } from '~/models'
import { db } from '../utils/db'
import type { Database, InvoiceRow, UserRow } from '../db/schema'
import { settleInvoiceInTx as settleCore, type SettleColumns } from './settleCore'

const FIO_PAYMENT_STATUS = {
  matched: 'matched',
  unmatched: 'unmatched',
} as const

export type DepositUserRow = Pick<
  UserRow,
  | 'id'
  | 'fullName'
  | 'email'
  | 'languageCode'
  | 'companyName'
  | 'companyIdNumber'
  | 'companyVatNumber'
  | 'address'
  | 'depositVs'
  | 'depositRequired'
  | 'depositBalanceAmount'
  | 'depositBalanceCurrency'
  | 'fakturoidId'
  | 'invoiceDueDays'
>

export const getUserForDeposit = async (userId: string): Promise<DepositUserRow | undefined> =>
  db
    .selectFrom('users')
    .select([
      'id',
      'fullName',
      'email',
      'languageCode',
      'companyName',
      'companyIdNumber',
      'companyVatNumber',
      'address',
      'depositVs',
      'depositRequired',
      'depositBalanceAmount',
      'depositBalanceCurrency',
      'fakturoidId',
      'invoiceDueDays',
    ])
    .where('id', '=', userId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst()

// Guarded by `fakturoid_id IS NULL` so a concurrent subject creation can't clobber an
// id that's already referenced by issued documents. Returns the PERSISTED winner —
// a caller that lost the race must continue with the winning id, not its own.
export const setUserFakturoidId = async (userId: string, fakturoidId: number): Promise<number> => {
  await db.updateTable('users').set({ fakturoidId }).where('id', '=', userId).where('fakturoidId', 'is', null).execute()
  const row = await db.selectFrom('users').select('fakturoidId').where('id', '=', userId).executeTakeFirst()
  return row?.fakturoidId ?? fakturoidId
}

export const findOpenDepositInvoice = async (
  userId: string,
  currency: DepositCurrency,
): Promise<InvoiceRow | undefined> =>
  db
    .selectFrom('invoices')
    .selectAll()
    .where('userId', '=', userId)
    .where('type', '=', DEPOSIT_INVOICE_TYPE)
    .where('status', '=', INVOICE_STATUS.unpaid)
    .where('priceCurrency', '=', currency)
    .orderBy('createdDate', 'desc')
    .executeTakeFirst()

export const findAnyOpenDepositInvoice = async (userId: string): Promise<InvoiceRow | undefined> =>
  db
    .selectFrom('invoices')
    .selectAll()
    .where('userId', '=', userId)
    .where('type', '=', DEPOSIT_INVOICE_TYPE)
    .where('status', '=', INVOICE_STATUS.unpaid)
    .orderBy('createdDate', 'desc')
    .executeTakeFirst()

interface RecordDepositInvoiceInput {
  userId: string
  amount: number
  currency: DepositCurrency
  vs: string
  iban: string
  dueDays: number
}

export const recordDepositInvoice = async (input: RecordDepositInvoiceInput): Promise<InvoiceRow> => {
  const now = new Date()
  // Serialized by the partial unique index (user_id, price_currency) WHERE unpaid+deposit
  // (migration 023): a concurrent second insert for the same open deposit no-ops, and we return the
  // invoice the winner created — so two transfer/checkout calls can't mint duplicate VS/proformas.
  const inserted = await db
    .insertInto('invoices')
    .values({
      id: randomUUID(),
      userId: input.userId,
      createdDate: now,
      invoiceCreatedDate: now,
      invoiceDueDate: new Date(now.getTime() + input.dueDays * 86_400_000),
      paidAt: null,
      status: INVOICE_STATUS.unpaid,
      priceAmount: input.amount,
      priceCurrency: input.currency,
      url: null,
      variableSymbol: input.vs,
      iban: input.iban,
      type: DEPOSIT_INVOICE_TYPE,
    })
    .onConflict(oc =>
      oc
        .columns(['userId', 'priceCurrency'])
        .where('status', '=', INVOICE_STATUS.unpaid)
        .where('type', '=', DEPOSIT_INVOICE_TYPE)
        .doNothing(),
    )
    .returningAll()
    .executeTakeFirst()
  return inserted ?? (await findOpenDepositInvoice(input.userId, input.currency))!
}

export const attachFakturoidDoc = async (invoiceId: string, fakturoidId: number, url: string): Promise<void> => {
  await db.updateTable('invoices').set({ fakturoidId, url }).where('id', '=', invoiceId).execute()
}

// Returns false when no OPEN invoice matched — it was settled/canceled between the caller's
// open-read and now (Fio cron / sibling card session). The caller must then not leave a payable
// session pointing at an already-settled deposit.
export const setInvoiceStripeSession = async (invoiceId: string, sessionId: string): Promise<boolean> => {
  const res = await db
    .updateTable('invoices')
    .set({ stripeSessionId: sessionId })
    .where('id', '=', invoiceId)
    .where('status', '=', INVOICE_STATUS.unpaid)
    .executeTakeFirst()
  return Number(res?.numUpdatedRows ?? 0) > 0
}

export interface SettledDeposit {
  invoiceId: string
  userId: string
  amount: number
  currency: string
  vs: string | null
  fakturoidId: number | null
  paidOn: Date
  // Stripe sessions attached to invoices this settle closed — still payable on
  // Stripe's side until expired by the caller (best-effort).
  canceledSessionIds: string[]
  // Fakturoid proformas of the canceled siblings — still open payable documents
  // until the caller fires their cancellation (best-effort).
  canceledFakturoidIds: number[]
}

// Deposit settle = the shared settle core (server/repos/settleCore.ts) with the deposit knobs:
// cancel the sibling-currency open proforma (a deposit is owed once) and, inside the same tx and only
// on a real settle, write the user's deposit balance. Behaviour is identical to the former private
// core — the CAS, sibling-cancel, and balance write are unchanged; they just live in the shared file
// now so the sale path can reuse the same charge-once machinery without a copy-paste.
const settleInvoiceInTx = (
  trx: Kysely<Database>,
  invoice: InvoiceRow,
  paidAmount: number,
  paidOn: Date,
  set: SettleColumns,
  extraSessionIds: (string | null)[],
): Promise<SettledDeposit | null> =>
  settleCore(trx, invoice, paidAmount, paidOn, set, extraSessionIds, {
    type: DEPOSIT_INVOICE_TYPE,
    cancelSiblings: true,
    afterSettle: async (t, inv) => {
      await t
        .updateTable('users')
        .set({ depositBalanceAmount: Number(inv.priceAmount), depositBalanceCurrency: inv.priceCurrency })
        .where('id', '=', inv.userId)
        .execute()
    },
  })

export interface FioSettleInput {
  account: 'CZK' | 'EUR'
  fioId: string
  amount: number
  currency: string
  vs: string | null
  counterAccount: string | null
  counterName: string | null
  message: string | null
  paidOn: Date
  raw: unknown
}

export interface FioSettleResult {
  claimed: boolean
  settled: SettledDeposit | null
}

// fio_ids already recorded for this account (matched or unmatched). Lets the cron skip the no-op
// claim INSERT for movements seen on a previous run: the (account, fio_id) dedupe still guarantees
// correctness, and an already-recorded movement is never re-matched anyway — this just avoids
// reopening a transaction per already-processed movement on every 5-minute run over the 7-day window.
export const loadProcessedFioIds = async (account: 'CZK' | 'EUR', ids: string[]): Promise<Set<string>> => {
  if (ids.length === 0) return new Set()
  const rows = await db
    .selectFrom('fioPayments')
    .select('fioId')
    .where('account', '=', account)
    .where('fioId', 'in', ids)
    .execute()
  return new Set(rows.map(r => r.fioId))
}

// Claim + settle in ONE transaction: the dedupe INSERT is the claim, and any failure
// (or process crash) before commit rolls the claim back too, so the next cron run
// retries the payment instead of stranding it. VS matching is zero-insensitive —
// banks transmit the variable symbol numerically and leading zeros don't survive.
export const settleFioPayment = async (p: FioSettleInput): Promise<FioSettleResult> =>
  db.transaction().execute(async trx => {
    const claim = await trx
      .insertInto('fioPayments')
      .values({
        account: p.account,
        fioId: p.fioId,
        amount: p.amount,
        currency: p.currency,
        vs: p.vs,
        counterAccount: p.counterAccount,
        counterName: p.counterName,
        message: p.message,
        paidOn: p.paidOn,
        raw: p.raw,
      })
      .onConflict(oc => oc.columns(['account', 'fioId']).doNothing())
      .returning('fioId')
      .executeTakeFirst()
    if (!claim) return { claimed: false, settled: null }

    const vsKey = p.vs?.replace(/^0+/, '') ?? ''
    if (!vsKey) return { claimed: true, settled: null }

    const invoice = await trx
      .selectFrom('invoices')
      .selectAll()
      .where(sql<string>`ltrim(variable_symbol, '0')`, '=', vsKey)
      .where('priceCurrency', '=', p.currency)
      .where('type', '=', DEPOSIT_INVOICE_TYPE)
      .where('status', '=', INVOICE_STATUS.unpaid)
      .orderBy('createdDate', 'asc')
      .executeTakeFirst()
    if (!invoice) return { claimed: true, settled: null }

    // The bank transfer won — an open card session for THIS invoice (cross-method
    // race) must die too, alongside the canceled siblings' sessions.
    const settled = await settleInvoiceInTx(trx, invoice, p.amount, p.paidOn, {}, [invoice.stripeSessionId])
    if (!settled) return { claimed: true, settled: null }

    await trx
      .updateTable('fioPayments')
      .set({ status: FIO_PAYMENT_STATUS.matched, matchedInvoiceId: settled.invoiceId })
      .where('account', '=', p.account)
      .where('fioId', '=', p.fioId)
      .execute()

    return { claimed: true, settled }
  })

export interface StripeDepositInput {
  userId: string
  invoiceId: string | null
  currency: string
  amount: number
  sessionId: string
  paymentIntent: string | null
}

export type StripeDepositOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'already_settled' }
  | { outcome: 'unmatched' }
  | { outcome: 'settled'; settled: SettledDeposit }

// Webhook claim + settle in ONE transaction. A throw rolls the event claim back so
// Stripe's redelivery re-runs the processing; terminal outcomes (duplicate /
// already_settled / unmatched) commit the claim and stop the 3-day retry loop.
export const processStripeDeposit = async (
  eventId: string,
  eventType: string,
  data: StripeDepositInput,
  paidOn: Date,
): Promise<StripeDepositOutcome> =>
  db.transaction().execute(async trx => {
    const claim = await trx
      .insertInto('processedStripeEvents')
      .values({ eventId, type: eventType })
      .onConflict(oc => oc.column('eventId').doNothing())
      .returning('eventId')
      .executeTakeFirst()
    if (!claim) return { outcome: 'duplicate' }

    const set: SettleColumns = { stripeSessionId: data.sessionId, stripePaymentIntent: data.paymentIntent }

    const settleById = async (invoiceId: string): Promise<SettledDeposit | null> => {
      const invoice = await trx
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', invoiceId)
        .where('userId', '=', data.userId)
        .where('type', '=', DEPOSIT_INVOICE_TYPE)
        .where('status', '=', INVOICE_STATUS.unpaid)
        .executeTakeFirst()
      if (!invoice || invoice.priceCurrency !== data.currency) return null
      return settleInvoiceInTx(trx, invoice, data.amount, paidOn, set, [])
    }

    let settled = data.invoiceId ? await settleById(data.invoiceId) : null

    if (!settled) {
      // Replay of a settle we already recorded? Only a Stripe settle writes the
      // payment intent — a Fio-settled invoice carrying this session id (attached at
      // checkout creation) is a REAL cross-method double charge, not a replay, and
      // must fall through to the unmatched alert.
      const existing = await trx
        .selectFrom('invoices')
        .select(['status', 'stripePaymentIntent'])
        .where('stripeSessionId', '=', data.sessionId)
        .executeTakeFirst()
      if (existing?.status === INVOICE_STATUS.paid && existing.stripePaymentIntent) {
        return { outcome: 'already_settled' }
      }

      // Metadata invoice missing/canceled — try the user's current open invoice.
      const fallback = await trx
        .selectFrom('invoices')
        .selectAll()
        .where('userId', '=', data.userId)
        .where('type', '=', DEPOSIT_INVOICE_TYPE)
        .where('status', '=', INVOICE_STATUS.unpaid)
        .where('priceCurrency', '=', data.currency)
        .orderBy('createdDate', 'desc')
        .executeTakeFirst()
      settled = fallback ? await settleInvoiceInTx(trx, fallback, data.amount, paidOn, set, []) : null
    }

    if (!settled) return { outcome: 'unmatched' }
    return { outcome: 'settled', settled }
  })

// Standalone claim for events that carry no work to lose (foreign types, malformed
// deposits) — losing the claim to a crash just re-runs the same terminal answer.
export const claimStripeEvent = async (eventId: string, type: string): Promise<boolean> => {
  const inserted = await db
    .insertInto('processedStripeEvents')
    .values({ eventId, type })
    .onConflict(oc => oc.column('eventId').doNothing())
    .returning('eventId')
    .executeTakeFirst()
  return inserted != null
}

// Stripe redelivers for at most ~3 days; on a shared Stripe account foreign events
// accumulate too — prune well past the retry window.
export const pruneProcessedStripeEvents = async (olderThanDays = 30): Promise<number> => {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000)
  const result = await db.deleteFrom('processedStripeEvents').where('processedAt', '<', cutoff).executeTakeFirst()
  return Number(result.numDeletedRows ?? 0)
}

export interface FakturoidPendingInvoice {
  id: string
  userId: string
  fakturoidId: number | null
  paidAt: Date | null
  priceAmount: string | null
  priceCurrency: string | null
  variableSymbol: string | null
}

// Paid deposits whose payment isn't recorded in Fakturoid yet — including invoices
// whose proforma never got issued (fakturoid_id NULL, Fakturoid was down at settle
// time). Oldest first so permanently failing rows can't starve newer ones forever.
export const listPaidInvoicesPendingFakturoid = async (limit = 20): Promise<FakturoidPendingInvoice[]> =>
  db
    .selectFrom('invoices')
    .select(['id', 'userId', 'fakturoidId', 'paidAt', 'priceAmount', 'priceCurrency', 'variableSymbol'])
    .where('type', '=', DEPOSIT_INVOICE_TYPE)
    .where('status', '=', INVOICE_STATUS.paid)
    .where('fakturoidPaidAt', 'is', null)
    .orderBy('paidAt', 'asc')
    .limit(limit)
    .execute()

export const setInvoiceFakturoidPaidAt = async (invoiceId: string): Promise<void> => {
  await db.updateTable('invoices').set({ fakturoidPaidAt: new Date() }).where('id', '=', invoiceId).execute()
}
