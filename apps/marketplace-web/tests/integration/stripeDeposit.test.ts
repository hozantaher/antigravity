import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import * as userRepo from '~/server/repos/userRepo'
import {
  claimStripeEvent,
  getUserForDeposit,
  processStripeDeposit,
  pruneProcessedStripeEvents,
  recordDepositInvoice,
  setInvoiceStripeSession,
  settleFioPayment,
  type StripeDepositInput,
} from '~/server/repos/depositRepo'

const RUN = !!process.env.POSTGRES_URL
const UID = 'itest-stripe1'
const UID2 = 'itest-stripe2'
const FIO_ID = '991000001'

const cleanup = async () => {
  await db.deleteFrom('processedStripeEvents').where('eventId', 'like', 'evt_itest%').execute()
  await db.deleteFrom('fioPayments').where('fioId', '=', FIO_ID).execute()
  await db.deleteFrom('invoices').where('userId', 'like', 'itest-stripe%').execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-stripe%').execute()
}

describe.skipIf(!RUN)('stripe deposit flow (Postgres)', () => {
  let czkInvoiceId = ''

  const stripeData = (over: Partial<StripeDepositInput>): StripeDepositInput => ({
    userId: UID,
    invoiceId: czkInvoiceId,
    currency: 'CZK',
    amount: 10000,
    sessionId: 'cs_itest_main',
    paymentIntent: 'pi_itest_1',
    ...over,
  })

  beforeAll(async () => {
    await cleanup()
    await userRepo.createOrGetUser({ uid: UID, email: 'itest-stripe@example.test', name: 'Stripe Tester' })
    await userRepo.createOrGetUser({ uid: UID2, email: 'itest-stripe2@example.test', name: 'Stripe Tester 2' })

    const user = (await getUserForDeposit(UID))!
    const czk = await recordDepositInvoice({
      userId: UID,
      amount: 10000,
      currency: 'CZK',
      vs: user.depositVs,
      iban: 'CZ8820100000002903525501',
      dueDays: 14,
    })
    czkInvoiceId = czk.id
    const eur = await recordDepositInvoice({
      userId: UID,
      amount: 500,
      currency: 'EUR',
      vs: user.depositVs,
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })
    // The EUR sibling has an open card session that must be expired after settle.
    await setInvoiceStripeSession(eur.id, 'cs_itest_sibling')
  })
  afterAll(cleanup)

  it('does not settle on underpayment or a foreign user (terminal unmatched, claim kept)', async () => {
    const underpaid = await processStripeDeposit(
      'evt_itest_1',
      'checkout.session.completed',
      stripeData({ amount: 9999.99 }),
      new Date(),
    )
    expect(underpaid.outcome).toBe('unmatched')

    const foreign = await processStripeDeposit(
      'evt_itest_2',
      'checkout.session.completed',
      stripeData({ userId: UID2, sessionId: 'cs_itest_foreign', paymentIntent: null }),
      new Date(),
    )
    expect(foreign.outcome).toBe('unmatched')

    const invoice = await db
      .selectFrom('invoices')
      .select('status')
      .where('id', '=', czkInvoiceId)
      .executeTakeFirstOrThrow()
    expect(invoice.status).toBe('unpaid')
  })

  it('settles by invoice id: paid + stripe ids + balance + sibling session collected', async () => {
    const paidOn = new Date('2026-06-11T00:00:00Z')
    const result = await processStripeDeposit('evt_itest_3', 'checkout.session.completed', stripeData({}), paidOn)

    expect(result.outcome).toBe('settled')
    if (result.outcome !== 'settled') return
    expect(result.settled.canceledSessionIds).toEqual(['cs_itest_sibling'])

    const invoice = await db.selectFrom('invoices').selectAll().where('id', '=', czkInvoiceId).executeTakeFirstOrThrow()
    expect(invoice.status).toBe('paid')
    expect(invoice.stripeSessionId).toBe('cs_itest_main')
    expect(invoice.stripePaymentIntent).toBe('pi_itest_1')
    expect(invoice.paidAt?.getTime()).toBe(paidOn.getTime())

    const user = (await getUserForDeposit(UID))!
    expect(Number(user.depositBalanceAmount)).toBe(10000)
    expect(user.depositBalanceCurrency).toBe('CZK')

    const eur = await db
      .selectFrom('invoices')
      .selectAll()
      .where('userId', '=', UID)
      .where('priceCurrency', '=', 'EUR')
      .executeTakeFirstOrThrow()
    expect(eur.status).toBe('canceled')
  })

  it('a redelivered event is rejected by the claim', async () => {
    const replay = await processStripeDeposit('evt_itest_3', 'checkout.session.completed', stripeData({}), new Date())
    expect(replay.outcome).toBe('duplicate')
  })

  it('a fresh event for the already-settled session is recognized as a replay (payment intent present)', async () => {
    const replay = await processStripeDeposit('evt_itest_4', 'checkout.session.completed', stripeData({}), new Date())
    expect(replay.outcome).toBe('already_settled')
  })

  it('a card charge against a Fio-settled invoice is NOT a replay — it surfaces as unmatched (refund candidate)', async () => {
    const user2 = (await getUserForDeposit(UID2))!
    const invoice = await recordDepositInvoice({
      userId: UID2,
      amount: 10000,
      currency: 'CZK',
      vs: user2.depositVs,
      iban: 'CZ8820100000002903525501',
      dueDays: 14,
    })
    await setInvoiceStripeSession(invoice.id, 'cs_itest_crossmethod')

    // Bank transfer wins the race; the Fio settle also collects the invoice's own
    // open card session for expiry.
    const { settled } = await settleFioPayment({
      account: 'CZK',
      fioId: FIO_ID,
      amount: 10000,
      currency: 'CZK',
      vs: user2.depositVs,
      counterAccount: null,
      counterName: null,
      message: null,
      paidOn: new Date(),
      raw: {},
    })
    expect(settled?.canceledSessionIds).toEqual(['cs_itest_crossmethod'])

    // The user completes the card payment anyway: the invoice is paid but carries no
    // stripe_payment_intent (Fio settled it), so this is a real double charge — it
    // must NOT short-circuit as already_settled.
    const doubleCharge = await processStripeDeposit(
      'evt_itest_5',
      'checkout.session.completed',
      stripeData({
        userId: UID2,
        invoiceId: invoice.id,
        sessionId: 'cs_itest_crossmethod',
        paymentIntent: 'pi_itest_2',
      }),
      new Date(),
    )
    expect(doubleCharge.outcome).toBe('unmatched')
  })

  it('claims standalone events exactly once and prunes old rows', async () => {
    expect(await claimStripeEvent('evt_itest_9', 'payment_intent.created')).toBe(true)
    expect(await claimStripeEvent('evt_itest_9', 'payment_intent.created')).toBe(false)

    // Backdate past the retention window — pruning by wall clock alone would race
    // the row's just-now processed_at.
    await db
      .updateTable('processedStripeEvents')
      .set({ processedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where('eventId', '=', 'evt_itest_9')
      .execute()
    const pruned = await pruneProcessedStripeEvents()
    expect(pruned).toBeGreaterThan(0)
    expect(await claimStripeEvent('evt_itest_9', 'payment_intent.created')).toBe(true)
  })
})
