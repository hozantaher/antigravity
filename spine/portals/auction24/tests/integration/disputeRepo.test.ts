import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { db } from '~/server/utils/db'
import * as repo from '~/server/repos/disputeRepo'

// Integration: dispute repo against docker Postgres (:5434). The settled-sale eligibility, per-invoice
// uniqueness and the SQL-enforced state machine (open → review → resolved, terminal) are real SQL, so
// they live here. Skipped without POSTGRES_URL.
const RUN = !!process.env.POSTGRES_URL
const SELLER = 'itest-disp-seller'
const BUYER = 'itest-disp-buyer'
const OTHER = 'itest-disp-other'
const ITEM = 'itest-disp-item'
const INV = 'itest-disp-inv'

const seedUser = (id: string) =>
  db
    .insertInto('users')
    .values({
      id,
      authType: 'email',
      fullName: `D ${id}`,
      email: `${id}@example.test`,
      emailVerified: true,
      languageCode: 'cz',
    })
    .onConflict(oc => oc.column('id').doNothing())
    .execute()

const cleanup = async () => {
  await db.deleteFrom('disputes').where('openerId', 'like', 'itest-disp-%').execute()
  await db.updateTable('items').set({ settlementInvoiceId: null }).where('userId', '=', SELLER).execute()
  await db.deleteFrom('invoices').where('id', '=', INV).execute()
  await db.deleteFrom('items').where('userId', '=', SELLER).execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-disp-%').execute()
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

describe.skipIf(!RUN)('disputeRepo (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await seedSettledSale()
  })
  afterAll(cleanup)
  beforeEach(async () => {
    await db.deleteFrom('disputes').where('openerId', 'like', 'itest-disp-%').execute()
  })

  it('grants eligibility only to the buyer of the settled sale', async () => {
    expect(await repo.findDisputeEligibility(BUYER, ITEM)).toEqual({ invoiceId: INV })
    expect(await repo.findDisputeEligibility(OTHER, ITEM)).toBeUndefined()
  })

  it('opens a case and refuses a second for the same settled sale (unique invoice)', async () => {
    const d = await repo.openDispute({ itemId: ITEM, invoiceId: INV, openerId: BUYER, reason: 'Not as described' })
    expect(d.status).toBe('open')
    await expect(repo.openDispute({ itemId: ITEM, invoiceId: INV, openerId: BUYER, reason: 'again' })).rejects.toThrow()
  })

  it('runs the state machine open → review → resolved and treats resolved as terminal', async () => {
    const d = await repo.openDispute({ itemId: ITEM, invoiceId: INV, openerId: BUYER, reason: 'Engine fault' })

    const reviewed = await repo.reviewDispute(d.id)
    expect(reviewed?.status).toBe('review')

    const resolved = await repo.resolveDispute(d.id, 'ops-admin', 'Partial refund agreed')
    expect(resolved?.status).toBe('resolved')
    expect(resolved?.resolution).toBe('Partial refund agreed') // documented
    expect(resolved?.resolvedBy).toBe('ops-admin')
    expect(resolved?.resolvedAt).toBeGreaterThan(0)

    // Terminal: a resolved case is never re-resolved or dragged back to review.
    expect(await repo.resolveDispute(d.id, 'ops-admin', 'again')).toBeUndefined()
    expect(await repo.reviewDispute(d.id)).toBeUndefined()
  })

  it('can resolve straight from open (skipping review)', async () => {
    const d = await repo.openDispute({ itemId: ITEM, invoiceId: INV, openerId: BUYER, reason: 'Quick' })
    const resolved = await repo.resolveDispute(d.id, 'ops-admin', 'Closed as resolved')
    expect(resolved?.status).toBe('resolved')
  })
})
