import type { Kysely } from 'kysely'
import { INVOICE_STATUS } from '~/models'
import type { Database, InvoiceRow } from '../db/schema'

// The single place that knows what "an invoice got paid" means, shared by deposit and sale settle
// paths so the charge-once CAS is never copy-pasted. CAS the invoice unpaid→paid; optionally cancel
// sibling open invoices of the same type+user (deposit only — a deposit is owed once; sales are
// item-scoped and a user can win many, so cancelSiblings is OFF for sales); run a type-specific
// in-tx side-effect (deposit balance write); report what the caller must clean up externally. Runs
// inside the caller's transaction — the CAS (WHERE status='unpaid') makes overlapping callers and
// replays harmless no-ops.

export interface SettleColumns {
  stripeSessionId?: string
  stripePaymentIntent?: string | null
}

export interface SettleCoreResult {
  invoiceId: string
  userId: string
  amount: number
  currency: string
  vs: string | null
  fakturoidId: number | null
  paidOn: Date
  // Stripe sessions attached to invoices this settle closed (this invoice's own + any canceled
  // siblings') — still payable on Stripe's side until expired by the caller (best-effort).
  canceledSessionIds: string[]
  // Fakturoid documents of the canceled siblings — still open payable documents until the caller
  // fires their cancellation (best-effort). Empty when cancelSiblings is off.
  canceledFakturoidIds: number[]
}

export interface SettleCoreOptions {
  // The invoice's discriminator. When cancelSiblings is true it scopes the sibling-cancel; it is NOT
  // otherwise used (the invoice is already located by the caller), so passing it keeps the cancel
  // query type-safe.
  type: string
  // Cancel the user's OTHER open invoices of this type (deposit: the sibling-currency proforma — a
  // deposit is owed once). Off for sales: each won item is its own independent sale invoice.
  cancelSiblings: boolean
  // Type-specific in-tx side-effect after the CAS lands (deposit: write the user's deposit balance).
  // Runs only when the CAS actually flipped a row, so it fires exactly once per real settle.
  afterSettle?: (trx: Kysely<Database>, invoice: InvoiceRow) => Promise<void>
}

export const settleInvoiceInTx = async (
  trx: Kysely<Database>,
  invoice: InvoiceRow,
  paidAmount: number,
  paidOn: Date,
  set: SettleColumns,
  extraSessionIds: (string | null)[],
  options: SettleCoreOptions,
): Promise<SettleCoreResult | null> => {
  if (invoice.priceAmount == null || !invoice.priceCurrency) return null

  // Integer cents — numeric comes back as a string and float compares would drift.
  const requiredCents = Math.round(Number(invoice.priceAmount) * 100)
  if (Math.round(paidAmount * 100) < requiredCents) return null

  const updated = await trx
    .updateTable('invoices')
    .set({ status: INVOICE_STATUS.paid, paidAt: paidOn, ...set })
    .where('id', '=', invoice.id)
    .where('status', '=', INVOICE_STATUS.unpaid)
    .returning(['id', 'userId', 'fakturoidId', 'variableSymbol'])
    .executeTakeFirst()
  if (!updated) return null

  if (options.afterSettle) await options.afterSettle(trx, invoice)

  // The deposit is owed once — close the sibling currency's open document so the user can't pay twice
  // against a still-open invoice. Sales never cancel siblings (each item is independent).
  const canceled = options.cancelSiblings
    ? await trx
        .updateTable('invoices')
        .set({ status: INVOICE_STATUS.canceled })
        .where('userId', '=', updated.userId)
        .where('type', '=', options.type)
        .where('status', '=', INVOICE_STATUS.unpaid)
        .returning(['stripeSessionId', 'fakturoidId'])
        .execute()
    : []

  return {
    invoiceId: updated.id,
    userId: updated.userId,
    amount: Number(invoice.priceAmount),
    currency: invoice.priceCurrency,
    vs: updated.variableSymbol,
    fakturoidId: updated.fakturoidId,
    paidOn,
    canceledSessionIds: [...extraSessionIds, ...canceled.map(c => c.stripeSessionId)].filter(
      (id): id is string => !!id,
    ),
    canceledFakturoidIds: canceled.map(c => c.fakturoidId).filter((id): id is number => id != null),
  }
}
