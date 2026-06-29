import { db } from '../utils/db'
import type { BidInsert, InvoiceInsert, ItemInsert, UserInsert } from '../db/schema'

// pg caps a statement at 65535 bind params; 500 rows stays well under that even
// for the widest table (items ~33 cols ≈ 16.5k params).
const CHUNK = 500

const chunk = <T>(rows: readonly T[], size = CHUNK): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

// Bulk INSERT … ON CONFLICT (id) DO UPDATE: every row carries its own proposed
// values, so the update clause reads them from the `excluded` pseudo-row. `id`
// and the app-owned columns (users.banned / tokens_valid_after / created) are
// intentionally left untouched, so re-running the migration preserves runtime
// state instead of resetting it.
export const upsertUsers = async (rows: UserInsert[]): Promise<void> => {
  for (const part of chunk(rows)) {
    await db
      .insertInto('users')
      .values(part)
      .onConflict(oc =>
        oc.column('id').doUpdateSet(eb => ({
          authType: eb.ref('excluded.authType'),
          fullName: eb.ref('excluded.fullName'),
          email: eb.ref('excluded.email'),
          companyName: eb.ref('excluded.companyName'),
          companyVatNumber: eb.ref('excluded.companyVatNumber'),
          companyIdNumber: eb.ref('excluded.companyIdNumber'),
          bankAccount: eb.ref('excluded.bankAccount'),
          phone: eb.ref('excluded.phone'),
          address: eb.ref('excluded.address'),
          vat: eb.ref('excluded.vat'),
          roles: eb.ref('excluded.roles'),
          depositBalanceAmount: eb.ref('excluded.depositBalanceAmount'),
          depositBalanceCurrency: eb.ref('excluded.depositBalanceCurrency'),
          invoiceDueDays: eb.ref('excluded.invoiceDueDays'),
          favoriteIds: eb.ref('excluded.favoriteIds'),
          languageCode: eb.ref('excluded.languageCode'),
          newsletter: eb.ref('excluded.newsletter'),
          emailVerified: eb.ref('excluded.emailVerified'),
          depositRequired: eb.ref('excluded.depositRequired'),
          fakturoidId: eb.ref('excluded.fakturoidId'),
        })),
      )
      .execute()
  }
}

// Placeholders for orphan userIds — never clobber an existing (real) row.
export const insertUsersIfMissing = async (rows: UserInsert[]): Promise<void> => {
  for (const part of chunk(rows)) {
    await db
      .insertInto('users')
      .values(part)
      .onConflict(oc => oc.column('id').doNothing())
      .execute()
  }
}

export const upsertItems = async (rows: ItemInsert[]): Promise<void> => {
  for (const part of chunk(rows)) {
    await db
      .insertInto('items')
      .values(part)
      .onConflict(oc =>
        oc.column('id').doUpdateSet(eb => ({
          internalId: eb.ref('excluded.internalId'),
          title: eb.ref('excluded.title'),
          image: eb.ref('excluded.image'),
          images: eb.ref('excluded.images'),
          images360: eb.ref('excluded.images360'),
          description: eb.ref('excluded.description'),
          highlights: eb.ref('excluded.highlights'),
          minimalPriceAmount: eb.ref('excluded.minimalPriceAmount'),
          minimalPriceCurrency: eb.ref('excluded.minimalPriceCurrency'),
          priceFromAmount: eb.ref('excluded.priceFromAmount'),
          priceFromCurrency: eb.ref('excluded.priceFromCurrency'),
          minBidAmount: eb.ref('excluded.minBidAmount'),
          minBidCurrency: eb.ref('excluded.minBidCurrency'),
          categoryId: eb.ref('excluded.categoryId'),
          userId: eb.ref('excluded.userId'),
          location: eb.ref('excluded.location'),
          countryCode: eb.ref('excluded.countryCode'),
          youtubeVideoId: eb.ref('excluded.youtubeVideoId'),
          priceHighlighted: eb.ref('excluded.priceHighlighted'),
          taxIncluded: eb.ref('excluded.taxIncluded'),
          sold: eb.ref('excluded.sold'),
          closed: eb.ref('excluded.closed'),
          hidden: eb.ref('excluded.hidden'),
          winner: eb.ref('excluded.winner'),
          email: eb.ref('excluded.email'),
          phone: eb.ref('excluded.phone'),
          startDate: eb.ref('excluded.startDate'),
          endDate: eb.ref('excluded.endDate'),
          type: eb.ref('excluded.type'),
          created: eb.ref('excluded.created'),
          updated: eb.ref('excluded.updated'),
          visibleUpdated: eb.ref('excluded.visibleUpdated'),
          gps: eb.ref('excluded.gps'),
        })),
      )
      .execute()
  }
}

// Bids have a synthetic bigserial id, so upsert-by-id is meaningless. Re-running
// the migration replaces the whole bid set for the touched items.
export const replaceBidsForItems = async (itemIds: string[], rows: BidInsert[]): Promise<void> => {
  if (itemIds.length === 0) return
  await db.transaction().execute(async trx => {
    for (const part of chunk(itemIds)) {
      await trx.deleteFrom('bids').where('itemId', 'in', part).execute()
    }
    for (const part of chunk(rows)) {
      if (part.length) await trx.insertInto('bids').values(part).execute()
    }
  })
}

export const upsertInvoices = async (rows: InvoiceInsert[]): Promise<void> => {
  for (const part of chunk(rows)) {
    await db
      .insertInto('invoices')
      .values(part)
      .onConflict(oc =>
        oc.column('id').doUpdateSet(eb => ({
          userId: eb.ref('excluded.userId'),
          createdDate: eb.ref('excluded.createdDate'),
          invoiceCreatedDate: eb.ref('excluded.invoiceCreatedDate'),
          invoiceDueDate: eb.ref('excluded.invoiceDueDate'),
          paidAt: eb.ref('excluded.paidAt'),
          status: eb.ref('excluded.status'),
          priceAmount: eb.ref('excluded.priceAmount'),
          priceCurrency: eb.ref('excluded.priceCurrency'),
          url: eb.ref('excluded.url'),
        })),
      )
      .execute()
  }
}
