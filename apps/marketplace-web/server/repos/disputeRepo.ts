import type { Dispute, DisputeStatus, NewDispute, Paginated } from '~/models'
import { db } from '../utils/db'
import { paginate, type PageParams } from '../utils/pagination'

interface DisputeRow {
  id: string
  itemId: string
  invoiceId: string
  openerId: string
  reason: string
  status: string
  resolution: string | null
  resolvedBy: string | null
  resolvedAt: Date | null
  created: Date
}

const rowToDispute = (r: DisputeRow): Dispute => ({
  id: r.id,
  itemId: r.itemId,
  invoiceId: r.invoiceId,
  openerId: r.openerId,
  reason: r.reason,
  status: r.status as DisputeStatus,
  resolution: r.resolution ?? undefined,
  resolvedBy: r.resolvedBy ?? undefined,
  resolvedAt: r.resolvedAt ? r.resolvedAt.getTime() : undefined,
  created: r.created.getTime(),
})

// Eligibility: only the buyer of a SETTLED sale may open a case, bound to that settled invoice. The
// settled sale lives on the item (settledAt + settlementInvoiceId); the buyer is item.winner.id.
export const findDisputeEligibility = async (
  openerId: string,
  itemId: string,
): Promise<{ invoiceId: string } | undefined> => {
  const item = await db
    .selectFrom('items')
    .select(['settledAt', 'settlementInvoiceId', 'winner'])
    .where('id', '=', itemId)
    .executeTakeFirst()
  if (!item || !item.settledAt || !item.settlementInvoiceId) return undefined // not a settled sale
  if (item.winner?.id !== openerId) return undefined // only the buyer of this sale may dispute it
  return { invoiceId: item.settlementInvoiceId }
}

export const disputeExistsForInvoice = async (invoiceId: string): Promise<boolean> => {
  const row = await db.selectFrom('disputes').select('id').where('invoiceId', '=', invoiceId).executeTakeFirst()
  return !!row
}

// Open a case. UNIQUE(invoice_id) makes a second case for the same settled sale a duplicate-key error
// → the endpoint maps it to 409.
export const openDispute = async (input: NewDispute): Promise<Dispute> => {
  const row = await db
    .insertInto('disputes')
    .values({ itemId: input.itemId, invoiceId: input.invoiceId, openerId: input.openerId, reason: input.reason })
    .returningAll()
    .executeTakeFirstOrThrow()
  return rowToDispute(row as DisputeRow)
}

export const getDisputeById = async (id: string): Promise<Dispute | undefined> => {
  if (!/^\d+$/.test(id)) return undefined
  const row = await db.selectFrom('disputes').selectAll().where('id', '=', id).executeTakeFirst()
  return row ? rowToDispute(row as DisputeRow) : undefined
}

// Move open → review. The WHERE status='open' enforces the state machine in SQL (atomic), so a case
// already resolved can't slide back. Returns undefined when no row matched (wrong id / wrong state).
export const reviewDispute = async (id: string): Promise<Dispute | undefined> => {
  if (!/^\d+$/.test(id)) return undefined
  const row = await db
    .updateTable('disputes')
    .set({ status: 'review' })
    .where('id', '=', id)
    .where('status', '=', 'open')
    .returningAll()
    .executeTakeFirst()
  return row ? rowToDispute(row as DisputeRow) : undefined
}

// The documented ops decision: status → resolved with a justification + the resolving admin, only from
// a non-terminal state (WHERE status IN open/review). resolved is terminal — a decision is never
// re-made. Returns undefined when no row matched (already resolved / wrong id).
export const resolveDispute = async (
  id: string,
  resolvedBy: string,
  resolution: string,
): Promise<Dispute | undefined> => {
  if (!/^\d+$/.test(id)) return undefined
  const row = await db
    .updateTable('disputes')
    .set({ status: 'resolved', resolution, resolvedBy, resolvedAt: new Date() })
    .where('id', '=', id)
    .where('status', 'in', ['open', 'review'])
    .returningAll()
    .executeTakeFirst()
  return row ? rowToDispute(row as DisputeRow) : undefined
}

// A user's own cases, newest first.
export const listForUser = (userId: string, params: PageParams): Promise<Paginated<Dispute>> =>
  paginate(
    db.selectFrom('disputes').where('openerId', '=', userId),
    qb => qb.orderBy('created', 'desc').orderBy('id', 'desc'),
    rows => rows.map(r => rowToDispute(r as DisputeRow)),
    params,
  )
