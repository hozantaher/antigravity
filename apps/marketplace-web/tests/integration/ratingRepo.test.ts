import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { db } from '~/server/utils/db'
import * as repo from '~/server/repos/ratingRepo'

// Integration: rating repo against docker Postgres (:5434). The eligibility gate (settled sale →
// buyer-only) and the per-invoice uniqueness are real SQL, so they live here, not in the mocked
// server project. Skipped without POSTGRES_URL.
const RUN = !!process.env.POSTGRES_URL
const SELLER = 'itest-rat-seller'
const BUYER = 'itest-rat-buyer'
const OTHER = 'itest-rat-other'
const ITEM = 'itest-rat-item'
const INV = 'itest-rat-inv'

const seedUser = (id: string) =>
  db
    .insertInto('users')
    .values({
      id,
      authType: 'email',
      fullName: `R ${id}`,
      email: `${id}@example.test`,
      emailVerified: true,
      languageCode: 'cz',
    })
    .onConflict(oc => oc.column('id').doNothing())
    .execute()

const cleanup = async () => {
  await db.deleteFrom('itemRatings').where('sellerId', '=', SELLER).execute()
  await db.updateTable('items').set({ settlementInvoiceId: null }).where('userId', '=', SELLER).execute()
  await db.deleteFrom('invoices').where('id', 'like', `${INV}%`).execute()
  await db.deleteFrom('items').where('userId', '=', SELLER).execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-rat-%').execute()
}

const seedSettledSale = async (): Promise<void> => {
  await seedUser(SELLER)
  await seedUser(BUYER)
  await seedUser(OTHER)
  await db.insertInto('invoices').values({ id: INV, userId: BUYER, status: 'paid', type: 'sale' }).execute()
  await db
    .insertInto('items')
    .values({
      id: ITEM,
      title: 'Sold car',
      image: '',
      categoryId: 'others',
      userId: SELLER,
      type: 'auction',
      sold: true,
      closed: true,
      hidden: false,
      winner: { id: BUYER, name: 'Buyer' },
      settledAt: new Date(),
      settlementInvoiceId: INV,
      created: new Date(),
    })
    .execute()
}

describe.skipIf(!RUN)('ratingRepo (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await seedSettledSale()
  })
  afterAll(cleanup)
  beforeEach(async () => {
    await db.deleteFrom('itemRatings').where('sellerId', '=', SELLER).execute()
  })

  it('grants eligibility only to the buyer of the settled sale', async () => {
    expect(await repo.findRatingEligibility(BUYER, ITEM)).toEqual({ invoiceId: INV, sellerId: SELLER })
    expect(await repo.findRatingEligibility(OTHER, ITEM)).toBeUndefined() // never bought it
    expect(await repo.findRatingEligibility(SELLER, ITEM)).toBeUndefined() // can't rate own sale
  })

  it('refuses eligibility on an unsettled item (settledAt null)', async () => {
    await db.updateTable('items').set({ settledAt: null }).where('id', '=', ITEM).execute()
    expect(await repo.findRatingEligibility(BUYER, ITEM)).toBeUndefined()
    await db.updateTable('items').set({ settledAt: new Date() }).where('id', '=', ITEM).execute()
  })

  it('creates a rating and refuses a second for the same settled sale (unique invoice)', async () => {
    const r = await repo.createRating({ itemId: ITEM, sellerId: SELLER, raterId: BUYER, invoiceId: INV, score: 5 })
    expect(r.score).toBe(5)
    await expect(
      repo.createRating({ itemId: ITEM, sellerId: SELLER, raterId: BUYER, invoiceId: INV, score: 1 }),
    ).rejects.toThrow()
  })

  it('aggregates a seller’s reputation across their ratings (visible at the seller)', async () => {
    for (const [i, score] of [5, 4, 3].entries()) {
      const inv = `${INV}-${i}`
      await db
        .insertInto('invoices')
        .values({ id: inv, userId: BUYER, status: 'paid', type: 'sale' })
        .onConflict(oc => oc.column('id').doNothing())
        .execute()
      await db
        .insertInto('itemRatings')
        .values({ itemId: ITEM, sellerId: SELLER, raterId: BUYER, invoiceId: inv, score })
        .execute()
    }
    expect(await repo.sellerReputation(SELLER)).toEqual({ sellerId: SELLER, count: 3, average: 4 })
    expect(await repo.sellerReputation(OTHER)).toEqual({ sellerId: OTHER, count: 0, average: null })
  })

  it('hides a rating so it drops out of reputation, but keeps it in the admin list', async () => {
    const inv = `${INV}-h`
    await db
      .insertInto('invoices')
      .values({ id: inv, userId: BUYER, status: 'paid', type: 'sale' })
      .onConflict(oc => oc.column('id').doNothing())
      .execute()
    const r = await repo.createRating({ itemId: ITEM, sellerId: SELLER, raterId: BUYER, invoiceId: inv, score: 1 })
    expect((await repo.sellerReputation(SELLER)).count).toBe(1)

    const hidden = await repo.setRatingStatus(r.id, 'hidden')
    expect(hidden?.status).toBe('hidden')
    expect(await repo.sellerReputation(SELLER)).toEqual({ sellerId: SELLER, count: 0, average: null })

    const page = await repo.listAdminRatingsPage({ page: 1, pageSize: 50, limit: 50, offset: 0 })
    expect(page.items.find(x => x.id === r.id)?.status).toBe('hidden')
  })
})
