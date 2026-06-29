import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ItemType } from '~/models'
import { db } from '~/server/utils/db'
import * as userRepo from '~/server/repos/userRepo'
import * as itemRepo from '~/server/repos/itemRepo'

const RUN = !!process.env.POSTGRES_URL
const UID = 'itest-close-u1'
const BIDDER = 'itest-close-bidder' // a different user bids — the seller (UID) may not bid on their own item
const HOUR = 3600_000

const cleanup = async () => {
  await db.deleteFrom('items').where('id', 'like', 'itest-close-%').execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-close-%').execute()
}

// placeBid refuses an already-ended auction, so bid while live, then fast-forward the
// end into the past to make the row closable — the state a 5-min-late cron run sees.
const endedAuctionWithBid = async (id: string, opts: { reserve?: number; bid?: number }): Promise<void> => {
  await itemRepo.createItem(
    {
      id,
      title: `Closer ${id}`,
      categoryId: 'car',
      type: ItemType.auction,
      startDate: Date.now() - HOUR,
      endDate: Date.now() + HOUR,
      priceFrom: { amount: 1000 },
      ...(opts.reserve != null ? { minimalPrice: { amount: opts.reserve } } : {}),
      hidden: false,
    },
    UID,
  )
  if (opts.bid != null) await itemRepo.placeBid(id, BIDDER, opts.bid)
  await db
    .updateTable('items')
    .set({ endDate: new Date(Date.now() - 1000) })
    .where('id', '=', id)
    .execute()
}

describe.skipIf(!RUN)('close-auctions repo (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await userRepo.createOrGetUser({ uid: UID, email: 'itest-close@example.test', name: 'Closer Tester' })
    await userRepo.createOrGetUser({ uid: BIDDER, email: 'itest-close-bidder@example.test', name: 'Closer Bidder' })
  })
  afterAll(cleanup)

  it('sells to the highest bidder above the reserve', async () => {
    await endedAuctionWithBid('itest-close-sold', { reserve: 4000, bid: 5000 })
    expect(await itemRepo.closeOneAuction('itest-close-sold')).toEqual({ sold: true })
    const item = await itemRepo.getById('itest-close-sold')
    expect(item?.closed).toBe(true)
    expect(item?.sold).toBe(true)
    expect(item?.winner?.id).toBe(BIDDER)
  })

  it('closes unsold when the top bid is below the reserve', async () => {
    await endedAuctionWithBid('itest-close-under', { reserve: 10000, bid: 5000 })
    expect(await itemRepo.closeOneAuction('itest-close-under')).toEqual({ sold: false })
    const item = await itemRepo.getById('itest-close-under')
    expect(item?.closed).toBe(true)
    expect(item?.sold).toBe(false)
    expect(item?.winner).toBeUndefined()
  })

  it('closes unsold when there are no bids', async () => {
    await endedAuctionWithBid('itest-close-nobids', {})
    expect(await itemRepo.closeOneAuction('itest-close-nobids')).toEqual({ sold: false })
    const item = await itemRepo.getById('itest-close-nobids')
    expect(item?.closed).toBe(true)
    expect(item?.sold).toBe(false)
  })

  it('lists only ended, unclosed, non-hidden auctions and is idempotent after closing', async () => {
    await endedAuctionWithBid('itest-close-listed', { bid: 2000 })
    await itemRepo.createItem(
      {
        id: 'itest-close-live',
        title: 'Live',
        categoryId: 'car',
        type: ItemType.auction,
        startDate: Date.now() - HOUR,
        endDate: Date.now() + HOUR,
        hidden: false,
      },
      UID,
    )
    await endedAuctionWithBid('itest-close-hidden', {})
    await db.updateTable('items').set({ hidden: true }).where('id', '=', 'itest-close-hidden').execute()

    const before = await itemRepo.listClosableAuctionIds(100)
    expect(before).toContain('itest-close-listed')
    expect(before).not.toContain('itest-close-live') // still live
    expect(before).not.toContain('itest-close-hidden') // hidden by admin

    await itemRepo.closeOneAuction('itest-close-listed')
    const after = await itemRepo.listClosableAuctionIds(100)
    expect(after).not.toContain('itest-close-listed') // closed → no longer closable
    expect(await itemRepo.closeOneAuction('itest-close-listed')).toBeNull() // re-close is a no-op
  })

  it('does not close an auction whose end is still in the future', async () => {
    await itemRepo.createItem(
      {
        id: 'itest-close-future',
        title: 'Future',
        categoryId: 'car',
        type: ItemType.auction,
        startDate: Date.now() - HOUR,
        endDate: Date.now() + HOUR,
        hidden: false,
      },
      UID,
    )
    expect(await itemRepo.closeOneAuction('itest-close-future')).toBeNull()
    expect((await itemRepo.getById('itest-close-future'))?.closed).toBe(false)
  })

  it('tracks pending winner e-mails via winner_emailed_at', async () => {
    await endedAuctionWithBid('itest-close-email', { reserve: 1000, bid: 3000 })
    await itemRepo.closeOneAuction('itest-close-email')

    const pending = await itemRepo.listWinnersPendingEmail(100)
    expect(pending.find(p => p.itemId === 'itest-close-email')?.winnerUserId).toBe(BIDDER)

    await itemRepo.markWinnerEmailed('itest-close-email')
    const after = await itemRepo.listWinnersPendingEmail(100)
    expect(after.some(p => p.itemId === 'itest-close-email')).toBe(false)
  })
})
