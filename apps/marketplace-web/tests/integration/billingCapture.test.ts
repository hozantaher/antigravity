import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import { ensureOpenSaleInvoice } from '~/server/repos/settlementRepo'
import type { Address } from '~/models'

// Integration: the sale invoice must capture + store the payer's billing address at settlement. Both
// the card-checkout and bank-transfer paths funnel through ensureOpenSaleInvoice, so proving the
// snapshot here proves it for both. Skipped without POSTGRES_URL.
const RUN = !!process.env.POSTGRES_URL
const SELLER = 'itest-bill-seller'
const BUYER = 'itest-bill-buyer'
const ITEM = 'itest-bill-item'
const ADDRESS: Address = {
  address: 'Hlavní 1',
  city: 'Praha',
  zip: '11000',
  country: { code2: 'CZ', code3: 'CZE', phoneCode: '+420', name: 'Česko', vat: 21 },
}

const seedUser = (id: string, address: Address | null) =>
  db
    .insertInto('users')
    .values({
      id,
      authType: 'email',
      fullName: `B ${id}`,
      email: `${id}@example.test`,
      emailVerified: true,
      languageCode: 'cz',
      address,
    })
    .onConflict(oc => oc.column('id').doNothing())
    .execute()

const cleanup = async () => {
  await db.updateTable('items').set({ settlementInvoiceId: null }).where('id', '=', ITEM).execute()
  await db.deleteFrom('invoices').where('userId', 'like', 'itest-bill-%').execute()
  await db.deleteFrom('items').where('id', '=', ITEM).execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-bill-%').execute()
}

describe.skipIf(!RUN)('sale invoice billing-address capture (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await seedUser(SELLER, null)
    await seedUser(BUYER, ADDRESS)
    await db
      .insertInto('items')
      .values({
        id: ITEM,
        title: 'Car',
        image: '',
        categoryId: 'others',
        userId: SELLER,
        type: 'auction',
        created: new Date(),
      })
      .execute()
  })
  afterAll(cleanup)

  it('snapshots the payer’s address onto the sale invoice at settlement', async () => {
    const { invoice, created } = await ensureOpenSaleInvoice({
      itemId: ITEM,
      userId: BUYER,
      amount: 1000,
      currency: 'CZK',
      vs: '1234567890',
      iban: 'CZ0000',
      dueDays: 14,
    })
    expect(created).toBe(true)
    expect(invoice.billingAddress).toEqual(ADDRESS) // captured + stored
  })

  it('stores null billing when the payer has no address (no fabricated data)', async () => {
    // Re-point the same item at a fresh settlement by a no-address payer.
    await db.updateTable('items').set({ settlementInvoiceId: null }).where('id', '=', ITEM).execute()
    await db.deleteFrom('invoices').where('userId', '=', BUYER).execute()
    await db.updateTable('users').set({ address: null }).where('id', '=', BUYER).execute()
    const { invoice } = await ensureOpenSaleInvoice({
      itemId: ITEM,
      userId: BUYER,
      amount: 1000,
      currency: 'CZK',
      vs: '1234567890',
      iban: 'CZ0000',
      dueDays: 14,
    })
    expect(invoice.billingAddress).toBeNull()
    await db.updateTable('users').set({ address: ADDRESS }).where('id', '=', BUYER).execute()
  })
})
