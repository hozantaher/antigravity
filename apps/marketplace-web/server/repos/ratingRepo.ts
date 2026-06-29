import type { NewRating, Paginated, Rating, SellerReputation } from '~/models'
import { reputationFromStats } from '~/models'
import { db } from '../utils/db'
import { paginate, type PageParams } from '../utils/pagination'

interface RatingRow {
  id: string
  itemId: string
  sellerId: string
  raterId: string
  invoiceId: string
  score: number
  comment: string | null
  status: string
  created: Date
}

// Admin projection: the public Rating plus its moderation status (the public Rating contract omits it).
export type AdminRating = Rating & { status: string }

const rowToRating = (r: RatingRow): Rating => ({
  id: r.id,
  itemId: r.itemId,
  sellerId: r.sellerId,
  raterId: r.raterId,
  invoiceId: r.invoiceId,
  score: r.score,
  comment: r.comment ?? undefined,
  created: r.created.getTime(),
})

const rowToAdminRating = (r: RatingRow): AdminRating => ({ ...rowToRating(r), status: r.status })

export type RatingStatus = 'visible' | 'hidden'

// The settled invoice a rating must bind to, plus the seller it credits.
export interface RatingEligibility {
  invoiceId: string
  sellerId: string
}

// Eligibility gate: a rating is earned ONLY by the buyer of a SETTLED sale. The settled sale lives on
// the item (settledAt + settlementInvoiceId, migration 025); the buyer is item.winner.id, the seller
// item.userId. Anyone else — including the seller themselves — gets undefined → the endpoint 403s.
export const findRatingEligibility = async (
  raterId: string,
  itemId: string,
): Promise<RatingEligibility | undefined> => {
  const item = await db
    .selectFrom('items')
    .select(['userId', 'settledAt', 'settlementInvoiceId', 'winner'])
    .where('id', '=', itemId)
    .executeTakeFirst()
  if (!item || !item.settledAt || !item.settlementInvoiceId) return undefined // not a settled sale
  if (item.winner?.id !== raterId) return undefined // only the buyer of this sale may rate
  if (item.userId === raterId) return undefined // a seller can't rate their own sale
  return { invoiceId: item.settlementInvoiceId, sellerId: item.userId }
}

// True when this settled sale has already been rated — a friendly pre-check for the 409. The UNIQUE
// (invoice_id) constraint is the real guard; this just turns the race-loser's duplicate-key error into
// a clean conflict.
export const ratingExistsForInvoice = async (invoiceId: string): Promise<boolean> => {
  const row = await db.selectFrom('itemRatings').select('id').where('invoiceId', '=', invoiceId).executeTakeFirst()
  return !!row
}

export const createRating = async (input: NewRating): Promise<Rating> => {
  const row = await db
    .insertInto('itemRatings')
    .values({
      itemId: input.itemId,
      sellerId: input.sellerId,
      raterId: input.raterId,
      invoiceId: input.invoiceId,
      score: input.score,
      comment: input.comment ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return rowToRating(row as RatingRow)
}

// Aggregated reputation for a seller — what the seller card and their vehicles surface. Empty →
// average null (no reputation yet), never a misleading zero. Hidden (moderated) ratings are excluded
// so a fraudulent rating, once hidden, stops affecting reputation.
export const sellerReputation = async (sellerId: string): Promise<SellerReputation> => {
  const row = await db
    .selectFrom('itemRatings')
    .select(eb => [eb.fn.countAll<string>().as('count'), eb.fn.avg<string | null>('score').as('average')])
    .where('sellerId', '=', sellerId)
    .where('status', '=', 'visible')
    .executeTakeFirst()
  const count = Number(row?.count ?? 0)
  const average = row?.average == null ? null : Number(row.average)
  return reputationFromStats(sellerId, count, average)
}

// Admin moderation list: every rating (all statuses), newest first, paginated.
export const listAdminRatingsPage = (params: PageParams): Promise<Paginated<AdminRating>> =>
  paginate(
    db.selectFrom('itemRatings'),
    qb => qb.orderBy('created', 'desc').orderBy('id', 'desc'),
    rows => rows.map(r => rowToAdminRating(r as RatingRow)),
    params,
  )

// Set a rating's moderation status. Returns the updated row, or undefined when no rating matched.
export const setRatingStatus = async (id: string, status: RatingStatus): Promise<AdminRating | undefined> => {
  if (!/^\d+$/.test(id)) return undefined
  const row = await db.updateTable('itemRatings').set({ status }).where('id', '=', id).returningAll().executeTakeFirst()
  return row ? rowToAdminRating(row as RatingRow) : undefined
}
