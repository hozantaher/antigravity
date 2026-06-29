import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import { listUnmatchedFioPayments, dismissFioPayment } from '~/server/repos/reconRepo'

const RUN = !!process.env.POSTGRES_URL
const FID = '999000111' // test fio movement id (bigint)

const cleanup = async () => {
  await db.deleteFrom('fioPayments').where('fioId', '=', FID).execute()
}

describe.skipIf(!RUN)('reconRepo (Postgres)', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  it('lists an unmatched movement, then dismisses it out of the queue', async () => {
    await db
      .insertInto('fioPayments')
      .values({
        account: 'CZK',
        fioId: FID,
        amount: 5000,
        currency: 'CZK',
        vs: '123',
        counterAccount: '1/0100',
        counterName: 'Tester',
        message: 'hello',
        paidOn: new Date(),
        matchedInvoiceId: null,
        status: 'unmatched',
        raw: {},
      })
      .execute()

    const queue = await listUnmatchedFioPayments({ page: 1, pageSize: 50, limit: 50, offset: 0 })
    expect(queue.items.find(m => m.fioId === FID)).toBeTruthy()

    expect(await dismissFioPayment('CZK', FID)).toBe(true)
    // Second dismiss is a no-op — the CAS only flips an 'unmatched' row.
    expect(await dismissFioPayment('CZK', FID)).toBe(false)

    const after = await listUnmatchedFioPayments({ page: 1, pageSize: 50, limit: 50, offset: 0 })
    expect(after.items.find(m => m.fioId === FID)).toBeFalsy()
  })
})
