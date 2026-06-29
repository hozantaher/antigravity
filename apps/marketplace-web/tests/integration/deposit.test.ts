import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import * as userRepo from '~/server/repos/userRepo'
import {
  attachFakturoidDoc,
  claimStripeEvent,
  findAnyOpenDepositInvoice,
  findOpenDepositInvoice,
  getUserForDeposit,
  listPaidInvoicesPendingFakturoid,
  processStripeDeposit,
  pruneProcessedStripeEvents,
  recordDepositInvoice,
  setInvoiceFakturoidPaidAt,
  setInvoiceStripeSession,
  setUserFakturoidId,
  settleFioPayment,
  type FioSettleInput,
  type StripeDepositInput,
} from '~/server/repos/depositRepo'

const RUN = !!process.env.POSTGRES_URL
const UID = 'itest-dep1'
const UID2 = 'itest-dep2'
const FIO_ID_BASE = 990_000_000

const fioPayment = (over: Partial<FioSettleInput>): FioSettleInput => ({
  account: 'CZK',
  fioId: String(FIO_ID_BASE),
  amount: 10000,
  currency: 'CZK',
  vs: null,
  counterAccount: null,
  counterName: null,
  message: null,
  paidOn: new Date(),
  raw: {},
  ...over,
})

const cleanup = async () => {
  await db
    .deleteFrom('fioPayments')
    .where('fioId', '>=', String(FIO_ID_BASE))
    .where('fioId', '<', String(FIO_ID_BASE + 1000))
    .execute()
  await db.deleteFrom('invoices').where('userId', 'like', 'itest-dep%').execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-dep%').execute()
}

describe.skipIf(!RUN)('deposit flow (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await userRepo.createOrGetUser({ uid: UID, email: 'itest-dep@example.test', name: 'Deposit Tester' })
    await userRepo.createOrGetUser({ uid: UID2, email: 'itest-dep2@example.test', name: 'Deposit Tester 2' })
  })
  afterAll(cleanup)

  it('assigns a unique 10-digit deposit VS without a leading zero', async () => {
    // Leading zeros don't survive the numeric interbank round trip (migration 020).
    const user = await getUserForDeposit(UID)
    expect(user?.depositVs).toMatch(/^[1-9]\d{9}$/)
    expect(Number(user?.depositBalanceAmount ?? 0)).toBe(0)
  })

  it('records open deposit invoices per currency and reuses them', async () => {
    const user = (await getUserForDeposit(UID))!
    const czk = await recordDepositInvoice({
      userId: UID,
      amount: 10000,
      currency: 'CZK',
      vs: user.depositVs,
      iban: 'CZ8820100000002903525501',
      dueDays: 14,
    })
    const eur = await recordDepositInvoice({
      userId: UID,
      amount: 500,
      currency: 'EUR',
      vs: user.depositVs,
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })
    expect(czk.status).toBe('unpaid')
    expect(czk.type).toBe('deposit')
    expect(czk.variableSymbol).toBe(user.depositVs)
    expect(czk.invoiceDueDate).toBeInstanceOf(Date)

    expect((await findOpenDepositInvoice(UID, 'CZK'))?.id).toBe(czk.id)
    expect((await findOpenDepositInvoice(UID, 'EUR'))?.id).toBe(eur.id)
  })

  it('dedupes concurrent open deposit invoices for the same user+currency (race guard)', async () => {
    const RUID = 'itest-dep-race'
    await userRepo.createOrGetUser({ uid: RUID, email: 'itest-dep-race@example.test', name: 'Race' })
    const u = (await getUserForDeposit(RUID))!
    const input = { userId: RUID, amount: 10000, currency: 'CZK' as const, vs: u.depositVs, iban: 'CZ_X', dueDays: 14 }
    const [a, b] = await Promise.all([recordDepositInvoice(input), recordDepositInvoice(input)])
    expect(a.id).toBe(b.id) // both initiations resolve to the single winning invoice
    const open = await db
      .selectFrom('invoices')
      .select('id')
      .where('userId', '=', RUID)
      .where('priceCurrency', '=', 'CZK')
      .where('status', '=', 'unpaid')
      .where('type', '=', 'deposit')
      .execute()
    expect(open).toHaveLength(1)
  })

  it('claims a Fio payment exactly once (no VS → unmatched, claim kept)', async () => {
    const payment = fioPayment({ fioId: String(FIO_ID_BASE + 1), vs: null })
    expect(await settleFioPayment(payment)).toEqual({ claimed: true, settled: null })
    expect(await settleFioPayment(payment)).toEqual({ claimed: false, settled: null })
  })

  it('does not settle on wrong currency or underpayment (claims stay as unmatched audit rows)', async () => {
    const user = (await getUserForDeposit(UID))!
    const wrongCurrency = await settleFioPayment(
      fioPayment({ fioId: String(FIO_ID_BASE + 2), vs: user.depositVs, currency: 'USD' }),
    )
    expect(wrongCurrency).toEqual({ claimed: true, settled: null })

    const underpaid = await settleFioPayment(
      fioPayment({ fioId: String(FIO_ID_BASE + 3), vs: user.depositVs, amount: 9999.99 }),
    )
    expect(underpaid).toEqual({ claimed: true, settled: null })

    expect(await findOpenDepositInvoice(UID, 'CZK')).toBeDefined()
  })

  it('settles a matching payment: invoice paid, balance set, sibling canceled, fio row matched', async () => {
    const user = (await getUserForDeposit(UID))!
    const paidOn = new Date('2026-06-10T00:00:00Z')
    const { claimed, settled } = await settleFioPayment(
      fioPayment({ fioId: String(FIO_ID_BASE + 4), vs: user.depositVs, paidOn }),
    )

    expect(claimed).toBe(true)
    expect(settled).not.toBeNull()
    expect(settled?.userId).toBe(UID)
    expect(settled?.amount).toBe(10000)
    expect(settled?.canceledFakturoidIds).toEqual([])

    const invoice = await db
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', settled!.invoiceId)
      .executeTakeFirstOrThrow()
    expect(invoice.status).toBe('paid')
    expect(invoice.paidAt?.getTime()).toBe(paidOn.getTime())

    const after = (await getUserForDeposit(UID))!
    expect(Number(after.depositBalanceAmount)).toBe(10000)
    expect(after.depositBalanceCurrency).toBe('CZK')

    // The EUR sibling can't be paid against anymore.
    expect(await findOpenDepositInvoice(UID, 'EUR')).toBeUndefined()
    const eurInvoice = await db
      .selectFrom('invoices')
      .selectAll()
      .where('userId', '=', UID)
      .where('priceCurrency', '=', 'EUR')
      .executeTakeFirstOrThrow()
    expect(eurInvoice.status).toBe('canceled')

    const fioRow = await db
      .selectFrom('fioPayments')
      .selectAll()
      .where('account', '=', 'CZK')
      .where('fioId', '=', String(FIO_ID_BASE + 4))
      .executeTakeFirstOrThrow()
    expect(fioRow.status).toBe('matched')
    expect(fioRow.matchedInvoiceId).toBe(settled!.invoiceId)
  })

  it('is idempotent: a replayed payment is rejected by the claim', async () => {
    const user = (await getUserForDeposit(UID))!
    const replay = await settleFioPayment(fioPayment({ fioId: String(FIO_ID_BASE + 4), vs: user.depositVs }))
    expect(replay).toEqual({ claimed: false, settled: null })
  })

  it('matches zero-insensitively: a bank-stripped VS still settles a zero-led invoice', async () => {
    await recordDepositInvoice({
      userId: UID2,
      amount: 10000,
      currency: 'CZK',
      vs: '0123456789',
      iban: 'CZ8820100000002903525501',
      dueDays: 14,
    })
    const { settled } = await settleFioPayment(fioPayment({ fioId: String(FIO_ID_BASE + 5), vs: '123456789' }))
    expect(settled?.userId).toBe(UID2)
    expect(settled?.vs).toBe('0123456789')
  })

  it('lists paid invoices pending Fakturoid even when the proforma was never issued', async () => {
    const paid = await db
      .selectFrom('invoices')
      .select('id')
      .where('userId', '=', UID)
      .where('status', '=', 'paid')
      .executeTakeFirstOrThrow()

    // fakturoid_id is NULL — the sweep must still pick it up (late-create path).
    expect((await listPaidInvoicesPendingFakturoid()).map(i => i.id)).toContain(paid.id)

    await attachFakturoidDoc(paid.id, 4242, 'https://app.fakturoid.cz/x')
    expect((await listPaidInvoicesPendingFakturoid()).map(i => i.id)).toContain(paid.id)

    await setInvoiceFakturoidPaidAt(paid.id)
    expect((await listPaidInvoicesPendingFakturoid()).map(i => i.id)).not.toContain(paid.id)
  })
})

// Stripe settle + remaining repo surface. Scoped to its own id prefix so it can run
// concurrently with the Fio block above.
const SUID = 'itest-deps1'
const SUID2 = 'itest-deps2'
const SUID3 = 'itest-deps3'
const EVT = 'itest-evt-'

const stripeInput = (over: Partial<StripeDepositInput>): StripeDepositInput => ({
  userId: SUID,
  invoiceId: null,
  currency: 'CZK',
  amount: 10000,
  sessionId: 'cs_test_default',
  paymentIntent: 'pi_default',
  ...over,
})

const stripeCleanup = async () => {
  await db.deleteFrom('processedStripeEvents').where('eventId', 'like', `${EVT}%`).execute()
  await db
    .deleteFrom('fioPayments')
    .where('fioId', '>=', String(FIO_ID_BASE))
    .where('fioId', '<', String(FIO_ID_BASE + 1000))
    .execute()
  await db.deleteFrom('invoices').where('userId', 'like', 'itest-deps%').execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-deps%').execute()
}

describe.skipIf(!RUN)('Stripe deposit + repo surface (Postgres)', () => {
  beforeAll(async () => {
    await stripeCleanup()
    await userRepo.createOrGetUser({ uid: SUID, email: 'itest-deps@example.test', name: 'Stripe Tester' })
    await userRepo.createOrGetUser({ uid: SUID2, email: 'itest-deps2@example.test', name: 'Stripe Tester 2' })
    await userRepo.createOrGetUser({ uid: SUID3, email: 'itest-deps3@example.test', name: 'Stripe Tester 3' })
  })
  afterAll(stripeCleanup)

  it('setUserFakturoidId persists when null and returns the persisted id on a lost race', async () => {
    expect(await setUserFakturoidId(SUID, 555)).toBe(555)
    expect((await getUserForDeposit(SUID))?.fakturoidId).toBe(555)
    // Already set → guarded UPDATE is a no-op; caller gets the winning id, not its own.
    expect(await setUserFakturoidId(SUID, 999)).toBe(555)
  })

  it('findAnyOpenDepositInvoice returns undefined with no open invoice, then the open one', async () => {
    expect(await findAnyOpenDepositInvoice(SUID2)).toBeUndefined()
    const inv = await recordDepositInvoice({
      userId: SUID2,
      amount: 500,
      currency: 'EUR',
      vs: '2222222222',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })
    expect((await findAnyOpenDepositInvoice(SUID2))?.id).toBe(inv.id)
  })

  it('processStripeDeposit settles by invoiceId: invoice paid, balance set, sibling canceled, session recorded', async () => {
    const czk = await recordDepositInvoice({
      userId: SUID,
      amount: 10000,
      currency: 'CZK',
      vs: '1111111111',
      iban: 'CZ8820100000002903525501',
      dueDays: 14,
    })
    const eur = await recordDepositInvoice({
      userId: SUID,
      amount: 500,
      currency: 'EUR',
      vs: '1111111111',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })
    const paidOn = new Date('2026-06-11T00:00:00Z')
    const res = await processStripeDeposit(
      `${EVT}1`,
      'checkout.session.completed',
      stripeInput({ invoiceId: czk.id, sessionId: 'cs_test_1', paymentIntent: 'pi_1' }),
      paidOn,
    )
    expect(res.outcome).toBe('settled')
    if (res.outcome !== 'settled') throw new Error('unreachable')
    expect(res.settled.invoiceId).toBe(czk.id)
    expect(res.settled.amount).toBe(10000)
    expect(res.settled.canceledFakturoidIds).toEqual([])

    const paid = await db.selectFrom('invoices').selectAll().where('id', '=', czk.id).executeTakeFirstOrThrow()
    expect(paid.status).toBe('paid')
    expect(paid.stripeSessionId).toBe('cs_test_1')
    expect(paid.stripePaymentIntent).toBe('pi_1')
    expect(paid.paidAt?.getTime()).toBe(paidOn.getTime())

    const user = (await getUserForDeposit(SUID))!
    expect(Number(user.depositBalanceAmount)).toBe(10000)
    expect(user.depositBalanceCurrency).toBe('CZK')

    const eurRow = await db.selectFrom('invoices').selectAll().where('id', '=', eur.id).executeTakeFirstOrThrow()
    expect(eurRow.status).toBe('canceled')
  })

  it('is idempotent on the event claim: a redelivered event is a duplicate no-op', async () => {
    const res = await processStripeDeposit(
      `${EVT}1`,
      'checkout.session.completed',
      stripeInput({ invoiceId: 'whatever', sessionId: 'cs_test_1' }),
      new Date(),
    )
    expect(res).toEqual({ outcome: 'duplicate' })
  })

  it('replays an already-settled session via the paid+payment-intent fast path', async () => {
    // Same session id, already paid with a payment intent → already_settled, not a re-settle.
    const res = await processStripeDeposit(
      `${EVT}2`,
      'checkout.session.completed',
      stripeInput({ invoiceId: null, sessionId: 'cs_test_1', paymentIntent: 'pi_1' }),
      new Date(),
    )
    expect(res).toEqual({ outcome: 'already_settled' })
  })

  it('falls back to the user current open invoice when metadata invoiceId is missing', async () => {
    const open = await recordDepositInvoice({
      userId: SUID,
      amount: 10000,
      currency: 'CZK',
      vs: '1111111111',
      iban: 'CZ8820100000002903525501',
      dueDays: 14,
    })
    const res = await processStripeDeposit(
      `${EVT}3`,
      'checkout.session.completed',
      stripeInput({ invoiceId: null, sessionId: 'cs_test_3', paymentIntent: 'pi_3' }),
      new Date('2026-06-12T00:00:00Z'),
    )
    expect(res.outcome).toBe('settled')
    if (res.outcome !== 'settled') throw new Error('unreachable')
    expect(res.settled.invoiceId).toBe(open.id)
  })

  it('returns unmatched (refund candidate) when no invoice matches', async () => {
    const res = await processStripeDeposit(
      `${EVT}4`,
      'checkout.session.completed',
      stripeInput({ userId: SUID2, invoiceId: null, sessionId: 'cs_test_4', paymentIntent: 'pi_4', currency: 'CZK' }),
      new Date(),
    )
    // SUID2 only has an EUR open invoice → CZK fallback finds nothing.
    expect(res).toEqual({ outcome: 'unmatched' })
  })

  it('treats a stale invoiceId of wrong currency as a miss, then unmatched', async () => {
    // invoiceId exists but its currency differs from the event → settleById returns null;
    // SUID2 has no open USD invoice for the fallback either.
    const eur = await findAnyOpenDepositInvoice(SUID2)
    const res = await processStripeDeposit(
      `${EVT}5`,
      'checkout.session.completed',
      stripeInput({
        userId: SUID2,
        invoiceId: eur!.id,
        sessionId: 'cs_test_5',
        paymentIntent: 'pi_5',
        currency: 'USD',
      }),
      new Date(),
    )
    expect(res).toEqual({ outcome: 'unmatched' })
  })

  it('does not settle on underpayment (settle-core amount gate)', async () => {
    const inv = await recordDepositInvoice({
      userId: SUID2,
      amount: 10000,
      currency: 'CZK',
      vs: '2222222222',
      iban: 'CZ8820100000002903525501',
      dueDays: 14,
    })
    const res = await processStripeDeposit(
      `${EVT}6`,
      'checkout.session.completed',
      stripeInput({ userId: SUID2, invoiceId: inv.id, sessionId: 'cs_test_6', amount: 9999.99 }),
      new Date(),
    )
    expect(res).toEqual({ outcome: 'unmatched' })
    const still = await db.selectFrom('invoices').select('status').where('id', '=', inv.id).executeTakeFirstOrThrow()
    expect(still.status).toBe('unpaid')
  })

  it('a session attached to an already-paid invoice WITHOUT a payment intent falls through to unmatched', async () => {
    // Cross-method: an open card session id was stamped on an invoice that a bank
    // transfer later settled (no stripePaymentIntent) — a real double charge, not a replay.
    // SUID3 has no other open invoice, so the fallback finds nothing → unmatched.
    const inv = await recordDepositInvoice({
      userId: SUID3,
      amount: 10000,
      currency: 'CZK',
      vs: '3333333333',
      iban: 'CZ8820100000002903525501',
      dueDays: 14,
    })
    await setInvoiceStripeSession(inv.id, 'cs_test_fio')
    await db.updateTable('invoices').set({ status: 'paid', paidAt: new Date() }).where('id', '=', inv.id).execute()
    const res = await processStripeDeposit(
      `${EVT}7`,
      'checkout.session.completed',
      stripeInput({ userId: SUID3, invoiceId: null, sessionId: 'cs_test_fio', paymentIntent: 'pi_7', currency: 'CZK' }),
      new Date(),
    )
    expect(res).toEqual({ outcome: 'unmatched' })
  })

  it('Fio settle reports a cross-method card session id in canceledSessionIds', async () => {
    // Dedicated VS so this invoice is the unambiguous match for the Fio payment.
    const open = await recordDepositInvoice({
      userId: SUID3,
      amount: 500,
      currency: 'EUR',
      vs: '3434343434',
      iban: 'CZ7920100000002503525502',
      dueDays: 14,
    })
    await setInvoiceStripeSession(open.id, 'cs_test_xrace')
    const { settled } = await settleFioPayment(
      fioPayment({
        fioId: String(FIO_ID_BASE + 100),
        vs: '3434343434',
        currency: 'EUR',
        amount: 500,
      }),
    )
    expect(settled?.invoiceId).toBe(open.id)
    expect(settled?.canceledSessionIds).toContain('cs_test_xrace')
  })

  it('settle-core returns null on a malformed invoice missing its amount', async () => {
    // Defensive guard: priceAmount NULL → settle-core bails before touching anything.
    const id = randomUUID()
    await db
      .insertInto('invoices')
      .values({
        id,
        userId: SUID3,
        status: 'unpaid',
        priceAmount: null,
        priceCurrency: 'CZK',
        variableSymbol: '3939393939',
        type: 'deposit',
        createdDate: new Date(),
      })
      .execute()
    const res = await processStripeDeposit(
      `${EVT}8`,
      'checkout.session.completed',
      stripeInput({ userId: SUID3, invoiceId: id, sessionId: 'cs_test_8', paymentIntent: 'pi_8', currency: 'CZK' }),
      new Date(),
    )
    // settleById → settleInvoiceInTx returns null; no other CZK open invoice → unmatched.
    expect(res).toEqual({ outcome: 'unmatched' })
    const still = await db.selectFrom('invoices').select('status').where('id', '=', id).executeTakeFirstOrThrow()
    expect(still.status).toBe('unpaid')
  })

  it('claimStripeEvent claims once then rejects the replay', async () => {
    expect(await claimStripeEvent(`${EVT}claim`, 'charge.refunded')).toBe(true)
    expect(await claimStripeEvent(`${EVT}claim`, 'charge.refunded')).toBe(false)
  })

  it('pruneProcessedStripeEvents deletes rows past the cutoff and keeps fresh ones', async () => {
    const fresh = `${EVT}prune-fresh`
    const old = `${EVT}prune-old`
    await claimStripeEvent(fresh, 'x')
    await db.insertInto('processedStripeEvents').values({ eventId: old, type: 'x' }).execute()
    await db
      .updateTable('processedStripeEvents')
      .set({ processedAt: new Date('2000-01-01T00:00:00Z') })
      .where('eventId', '=', old)
      .execute()

    const deleted = await pruneProcessedStripeEvents(30)
    expect(deleted).toBeGreaterThanOrEqual(1)
    const oldRow = await db
      .selectFrom('processedStripeEvents')
      .select('eventId')
      .where('eventId', '=', old)
      .executeTakeFirst()
    expect(oldRow).toBeUndefined()
    const freshRow = await db
      .selectFrom('processedStripeEvents')
      .select('eventId')
      .where('eventId', '=', fresh)
      .executeTakeFirst()
    expect(freshRow?.eventId).toBe(fresh)
  })
})
