import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import * as userRepo from '~/server/repos/userRepo'
import {
  ensureOpenSaleInvoice,
  findSettlementCandidate,
  markSaleCompleted,
  processStripeSale,
  settleSaleFioPayment,
  type StripeSaleInput,
} from '~/server/repos/settlementRepo'

const RUN = !!process.env.POSTGRES_URL
const SELLER = 'itest-sale-seller'
const WINNER = 'itest-sale-winner'

// Seed a sold+closed auction with a winning bid. Mirrors the column shapes the mapper expects.
const seedWonItem = async (
  itemId: string,
  opts: { finalAmount: number; currency: string; winnerId: string },
): Promise<void> => {
  await db
    .insertInto('items')
    .values({
      id: itemId,
      title: 'Won car',
      image: '',
      categoryId: 'others',
      userId: SELLER,
      type: 'auction',
      sold: true,
      closed: true,
      hidden: false,
      winner: { id: opts.winnerId, name: 'Winner' },
      created: new Date(),
    })
    .execute()
  await db
    .insertInto('bids')
    .values({
      itemId,
      userId: opts.winnerId,
      amount: opts.finalAmount,
      currencyCode: opts.currency,
      date: new Date(),
    })
    .execute()
}

const setDepositBalance = async (userId: string, amount: number, currency: string): Promise<void> => {
  await db
    .updateTable('users')
    .set({ depositBalanceAmount: amount, depositBalanceCurrency: currency })
    .where('id', '=', userId)
    .execute()
}

const cleanup = async () => {
  await db.deleteFrom('processedStripeEvents').where('eventId', 'like', 'evt_isale%').execute()
  await db.deleteFrom('bids').where('userId', 'like', 'itest-sale%').execute()
  // Clear the item→invoice link before deleting invoices (FK).
  await db.updateTable('items').set({ settlementInvoiceId: null }).where('userId', '=', SELLER).execute()
  await db.deleteFrom('invoices').where('userId', 'like', 'itest-sale%').execute()
  await db.deleteFrom('items').where('userId', '=', SELLER).execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-sale%').execute()
}

describe.skipIf(!RUN)('sale settlement flow (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await userRepo.createOrGetUser({ uid: SELLER, email: 'itest-sale-seller@example.test', name: 'Seller' })
    await userRepo.createOrGetUser({ uid: WINNER, email: 'itest-sale-winner@example.test', name: 'Winner' })
  })
  afterAll(cleanup)

  it('round-trips the migration-025 items columns (settled_at + settlement_invoice_id)', async () => {
    await seedWonItem('itest-sale-cols', { finalAmount: 100, currency: 'EUR', winnerId: WINNER })
    const row = await db
      .selectFrom('items')
      .select(['settledAt', 'settlementInvoiceId'])
      .where('id', '=', 'itest-sale-cols')
      .executeTakeFirstOrThrow()
    expect(row.settledAt).toBeNull()
    expect(row.settlementInvoiceId).toBeNull()
  })

  it('computes the candidate: final price + deposit credit (I4 same-currency offset)', async () => {
    await seedWonItem('itest-sale-cand', { finalAmount: 32000, currency: 'EUR', winnerId: WINNER })
    await setDepositBalance(WINNER, 500, 'EUR')
    const c = await findSettlementCandidate('itest-sale-cand')
    expect(c?.winnerId).toBe(WINNER)
    expect(Number(c?.finalAmount)).toBe(32000)
    expect(c?.finalCurrency).toBe('EUR')
    expect(Number(c?.depositBalanceAmount)).toBe(500)
  })

  it('I1: concurrent ensureOpenSaleInvoice creates EXACTLY ONE sale invoice', async () => {
    await seedWonItem('itest-sale-claim', { finalAmount: 20000, currency: 'EUR', winnerId: WINNER })
    const input = {
      itemId: 'itest-sale-claim',
      userId: WINNER,
      amount: 20000,
      currency: 'EUR',
      vs: '5000000001',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    }
    // Race two concurrent "start settlement" calls.
    const [a, b] = await Promise.all([
      ensureOpenSaleInvoice(input),
      ensureOpenSaleInvoice({ ...input, vs: '5000000002' }),
    ])
    // Both resolve to the SAME invoice id (one created, the other reused).
    expect(a.invoice.id).toBe(b.invoice.id)
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1)

    const count = await db
      .selectFrom('invoices')
      .select(db.fn.countAll().as('n'))
      .where('userId', '=', WINNER)
      .where('type', '=', 'sale')
      .where('id', 'in', [a.invoice.id])
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(1)

    const item = await db
      .selectFrom('items')
      .select('settlementInvoiceId')
      .where('id', '=', 'itest-sale-claim')
      .executeTakeFirstOrThrow()
    expect(item.settlementInvoiceId).toBe(a.invoice.id)
  })

  it('settles a sale invoice once via Fio, then a replay is a no-op (I3, I5)', async () => {
    await seedWonItem('itest-sale-fio', { finalAmount: 15000, currency: 'EUR', winnerId: WINNER })
    const { invoice } = await ensureOpenSaleInvoice({
      itemId: 'itest-sale-fio',
      userId: WINNER,
      amount: 15000,
      currency: 'EUR',
      vs: '5100000001',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })

    const paidOn = new Date('2026-06-20T00:00:00Z')
    const first = await settleSaleFioPayment({
      account: 'EUR',
      fioId: 'fio-sale-1',
      amount: 15000,
      currency: 'EUR',
      vs: '5100000001',
      paidOn,
    })
    expect(first.settled).not.toBeNull()
    expect(first.settled?.invoiceId).toBe(invoice.id)
    expect(first.settled?.itemId).toBe('itest-sale-fio')

    const paid = await db.selectFrom('invoices').selectAll().where('id', '=', invoice.id).executeTakeFirstOrThrow()
    expect(paid.status).toBe('paid')
    expect(paid.paidAt?.getTime()).toBe(paidOn.getTime())

    // Complete-once stamp.
    expect(await markSaleCompleted('itest-sale-fio', paidOn)).toBe(true)
    const stamped = await db
      .selectFrom('items')
      .select('settledAt')
      .where('id', '=', 'itest-sale-fio')
      .executeTakeFirstOrThrow()
    expect(stamped.settledAt?.getTime()).toBe(paidOn.getTime())

    // I5: replaying the same payment settles nothing (invoice no longer unpaid).
    const replay = await settleSaleFioPayment({
      account: 'EUR',
      fioId: 'fio-sale-1',
      amount: 15000,
      currency: 'EUR',
      vs: '5100000001',
      paidOn: new Date(),
    })
    expect(replay.settled).toBeNull()

    // Complete-once: a second stamp is a no-op.
    expect(await markSaleCompleted('itest-sale-fio', new Date())).toBe(false)
    const again = await db
      .selectFrom('items')
      .select('settledAt')
      .where('id', '=', 'itest-sale-fio')
      .executeTakeFirstOrThrow()
    expect(again.settledAt?.getTime()).toBe(paidOn.getTime())
  })

  it('does not settle on underpayment (settle-core amount gate)', async () => {
    await seedWonItem('itest-sale-under', { finalAmount: 9000, currency: 'EUR', winnerId: WINNER })
    const { invoice } = await ensureOpenSaleInvoice({
      itemId: 'itest-sale-under',
      userId: WINNER,
      amount: 9000,
      currency: 'EUR',
      vs: '5200000001',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })
    const res = await settleSaleFioPayment({
      account: 'EUR',
      fioId: 'fio-sale-under',
      amount: 8999.99,
      currency: 'EUR',
      vs: '5200000001',
      paidOn: new Date(),
    })
    expect(res.settled).toBeNull()
    const still = await db
      .selectFrom('invoices')
      .select('status')
      .where('id', '=', invoice.id)
      .executeTakeFirstOrThrow()
    expect(still.status).toBe('unpaid')
  })

  it('settles via Stripe by invoice id; a redelivered event is a duplicate (I5)', async () => {
    await seedWonItem('itest-sale-stripe', { finalAmount: 12000, currency: 'EUR', winnerId: WINNER })
    const { invoice } = await ensureOpenSaleInvoice({
      itemId: 'itest-sale-stripe',
      userId: WINNER,
      amount: 12000,
      currency: 'EUR',
      vs: '5300000001',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })
    const data: StripeSaleInput = {
      userId: WINNER,
      invoiceId: invoice.id,
      currency: 'EUR',
      amount: 12000,
      sessionId: 'cs_isale_1',
      paymentIntent: 'pi_isale_1',
    }
    const paidOn = new Date('2026-06-21T00:00:00Z')
    const settled = await processStripeSale('evt_isale_1', 'checkout.session.completed', data, paidOn)
    expect(settled.outcome).toBe('settled')

    const paid = await db.selectFrom('invoices').selectAll().where('id', '=', invoice.id).executeTakeFirstOrThrow()
    expect(paid.status).toBe('paid')
    expect(paid.stripePaymentIntent).toBe('pi_isale_1')

    // Duplicate event → claimed already.
    const replay = await processStripeSale('evt_isale_1', 'checkout.session.completed', data, new Date())
    expect(replay.outcome).toBe('duplicate')

    // Fresh event, already-paid session WITH a payment intent → recognized replay, not double charge.
    const crossReplay = await processStripeSale('evt_isale_2', 'checkout.session.completed', data, new Date())
    expect(crossReplay.outcome).toBe('already_settled')
  })

  it('amountDue==0 path: deposit fully covers → invoice created already paid, completed once', async () => {
    // Deposit (500 EUR) ≥ final price (400 EUR) → amountDue 0.
    await seedWonItem('itest-sale-free', { finalAmount: 400, currency: 'EUR', winnerId: WINNER })
    await setDepositBalance(WINNER, 500, 'EUR')

    const now = new Date()
    const { invoice, created } = await ensureOpenSaleInvoice({
      itemId: 'itest-sale-free',
      userId: WINNER,
      amount: 400,
      currency: 'EUR',
      vs: '5400000001',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
      paid: true,
      paidOn: now,
    })
    expect(created).toBe(true)
    expect(invoice.status).toBe('paid')

    // Completed exactly once.
    expect(await markSaleCompleted('itest-sale-free', now)).toBe(true)
    expect(await markSaleCompleted('itest-sale-free', now)).toBe(false)

    const c = await findSettlementCandidate('itest-sale-free')
    expect(c?.invoice?.status).toBe('paid')
    expect(c?.settledAt).not.toBeNull()
  })

  it('I2: settled_at is only set once the invoice is paid (unpaid sale has no marker)', async () => {
    await seedWonItem('itest-sale-i2', { finalAmount: 7000, currency: 'EUR', winnerId: WINNER })
    await ensureOpenSaleInvoice({
      itemId: 'itest-sale-i2',
      userId: WINNER,
      amount: 7000,
      currency: 'EUR',
      vs: '5500000001',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })
    const c = await findSettlementCandidate('itest-sale-i2')
    expect(c?.invoice?.status).toBe('unpaid')
    expect(c?.settledAt).toBeNull()
  })
})
