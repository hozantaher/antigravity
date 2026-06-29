#!/usr/bin/env tsx
// Seed Postgres from the fixtures so the dev UI has data. Idempotent: it wipes
// only the fixed fixture IDs, so real (Firebase) users/invoices are untouched.
//
// Listings are no longer seeded — the fixture items are only wiped so a re-run
// clears any previously seeded ads. The fixture users (u1, admin1) and bidders
// (b1–b4) are placeholder rows with no Firebase account, kept to satisfy FKs.
// Real visitors get their own rows on first login.
import type { User } from '../models'
import { AuthType, UserRole } from '../models'
import { buildUsers, buildItems, buildInvoices, EUR, languages } from '../server/data/fixtures'
import { userToInsert, invoiceToInsert } from '../server/repos/mappers'
import { loadEnv } from './load-env'

loadEnv()
// Batch work: opt out of the request-path statement timeout.
process.env.POSTGRES_STATEMENT_TIMEOUT ??= '0'

const makeBidder = (id: string): User => ({
  id,
  authType: AuthType.email,
  fullName: `Bidder ${id.toUpperCase()}`,
  email: `${id}@auction24.cz`,
  roles: [UserRole.user],
  depositBalance: { amount: 0, currency: EUR },
  invoiceDueDays: 14,
  favoriteIds: [],
  language: languages[0]!,
  newsletter: false,
})

const main = async () => {
  const { db, destroyDb } = await import('../server/utils/db')

  const users = [...buildUsers(), ...['b1', 'b2', 'b3', 'b4'].map(makeBidder)]
  const itemIds = buildItems().map(i => i.id)
  const invoices = buildInvoices()

  try {
    await db.transaction().execute(async trx => {
      // Wipe the fixture scope first (items cascade their bids).
      await trx.deleteFrom('items').where('id', 'in', itemIds).execute()
      await trx
        .deleteFrom('invoices')
        .where(
          'id',
          'in',
          invoices.map(i => i.id),
        )
        .execute()
      await trx
        .deleteFrom('users')
        .where(
          'id',
          'in',
          users.map(u => u.id),
        )
        .execute()

      await trx.insertInto('users').values(users.map(userToInsert)).execute()
      await trx.insertInto('invoices').values(invoices.map(invoiceToInsert)).execute()
    })
    console.log(`Seeded ${users.length} users, ${invoices.length} invoices`)
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    await destroyDb()
  }
}

main()
