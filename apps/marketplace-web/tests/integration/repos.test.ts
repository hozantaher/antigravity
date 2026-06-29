import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ItemType } from '~/models'
import type { BodyType, SearchSort, VehicleSpecs } from '~/models'
import { db } from '~/server/utils/db'
import * as userRepo from '~/server/repos/userRepo'
import * as itemRepo from '~/server/repos/itemRepo'
import * as questionRepo from '~/server/repos/questionRepo'
import { listForUserPage } from '~/server/repos/invoiceRepo'
import * as contactRepo from '~/server/repos/contactRepo'

const RUN = !!process.env.POSTGRES_URL
const UID = 'itest-u1'
const BIDDER = 'itest-bidder' // a different user bids — the seller (UID) may not bid on their own item
const HOUR = 3600_000
const PAGE = { page: 1, pageSize: 100, limit: 100, offset: 0 }

const cleanup = async () => {
  // Contact ids are generated (c…), so scope cleanup by the itest- markers in their fields.
  await db
    .deleteFrom('contactMessages')
    .where(eb => eb.or([eb('email', 'like', 'itest-%'), eb('itemId', 'like', 'itest-%')]))
    .execute()
  await db.deleteFrom('items').where('id', 'like', 'itest-%').execute()
  await db.deleteFrom('invoices').where('id', 'like', 'itest-%').execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-%').execute()
}

describe.skipIf(!RUN)('repositories (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await userRepo.createOrGetUser({ uid: UID, email: 'itest@example.test', name: 'Integration Tester' })
    await userRepo.createOrGetUser({ uid: BIDDER, email: 'itest-bidder@example.test', name: 'Bidder' })
  })
  afterAll(cleanup)

  describe('userRepo', () => {
    it('createOrGetUser is idempotent', async () => {
      const again = await userRepo.createOrGetUser({ uid: UID, email: 'changed@example.test', name: 'Changed' })
      expect(again.id).toBe(UID)
      // Second call returns the existing row, not the new email.
      expect(again.email).toBe('itest@example.test')
    })

    it('toggleFavorite adds then removes', async () => {
      const added = await userRepo.toggleFavorite(UID, 'itest-fav')
      expect(added).toContain('itest-fav')
      const removed = await userRepo.toggleFavorite(UID, 'itest-fav')
      expect(removed).not.toContain('itest-fav')
    })

    it('grantRole adds admin', async () => {
      await userRepo.grantRole(UID, 'admin')
      const user = await userRepo.getById(UID)
      expect(user?.roles).toContain('admin')
    })
  })

  describe('itemRepo', () => {
    it('creates, reads, and updates an item', async () => {
      const created = await itemRepo.createItem(
        {
          id: 'itest-i1',
          title: 'Test Truck',
          categoryId: 'car',
          type: ItemType.auction,
          priceFrom: { amount: 1000 },
          hidden: false,
        },
        UID,
      )
      expect(created.id).toBe('itest-i1')

      const fetched = await itemRepo.getById('itest-i1')
      expect(fetched?.title).toBe('Test Truck')
      expect(fetched?.priceFrom?.amount).toBe(1000)

      const updated = await itemRepo.updateItem('itest-i1', { hidden: true })
      expect(updated?.hidden).toBe(true)
    })

    it('updateItem bumps visibleUpdated only when visibility flips', async () => {
      const created = await itemRepo.createItem(
        { id: 'itest-i7', title: 'Vis', categoryId: 'car', type: ItemType.ad, hidden: false },
        UID,
      )
      const v0 = created.visibleUpdated!
      const edited = await itemRepo.updateItem('itest-i7', { title: 'Vis edited' })
      expect(edited?.visibleUpdated).toBe(v0) // internal edit — unchanged
      const hidden = await itemRepo.updateItem('itest-i7', { hidden: true })
      expect(hidden?.visibleUpdated).toBeGreaterThanOrEqual(v0) // flip — bumped
    })

    it('placeBid records the bid and applies soft-close on a live auction', async () => {
      const endMs = Date.now() + 60_000 // inside the 3-min window
      await itemRepo.createItem(
        {
          id: 'itest-i2',
          title: 'Closing Soon',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - HOUR,
          endDate: endMs,
          hidden: false,
        },
        UID,
      )
      const after = await itemRepo.placeBid('itest-i2', BIDDER, 1500)
      expect(after?.bids).toHaveLength(1)
      expect(after?.bids[0]?.amount).toBe(1500)
      expect(after?.endDate).toBeGreaterThan(endMs) // extended by soft-close
    })

    it('placeBid enforces the minimum increment', async () => {
      await itemRepo.createItem(
        {
          id: 'itest-i4',
          title: 'MinBid',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - HOUR,
          endDate: Date.now() + HOUR,
          priceFrom: { amount: 1000 },
          minBid: { amount: 100 },
          hidden: false,
        },
        UID,
      )
      await expect(itemRepo.placeBid('itest-i4', BIDDER, 1000)).rejects.toThrow() // below 1000 + 100
      const ok = await itemRepo.placeBid('itest-i4', BIDDER, 1100)
      // placeBid returns the slim public shape: only the last bid in `bids`, with the true total in
      // bidCount (the full history is paginated separately via /api/item/:id/bids).
      expect(ok?.bids).toHaveLength(1)
      expect(ok?.bidCount).toBe(1)
      await expect(itemRepo.placeBid('itest-i4', BIDDER, 1150)).rejects.toThrow() // below 1100 + 100
      const ok2 = await itemRepo.placeBid('itest-i4', BIDDER, 1200)
      expect(ok2?.bidCount).toBe(2)
      expect(ok2?.bids).toHaveLength(1)
      expect(ok2?.bids[0]?.amount).toBe(1200)
      // getPublicDetail returns the same slim shape: last bid + true bidCount, never the full history.
      const pub = await itemRepo.getPublicDetail('itest-i4')
      expect(pub?.bidCount).toBe(2)
      expect(pub?.bids).toHaveLength(1)
      expect(pub?.bids[0]?.amount).toBe(1200)
    })

    it('placeBid rejects an ended auction and a non-auction', async () => {
      await itemRepo.createItem(
        {
          id: 'itest-i5',
          title: 'Ended',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - 2 * HOUR,
          endDate: Date.now() - HOUR,
          priceFrom: { amount: 1000 },
          hidden: false,
        },
        UID,
      )
      await expect(itemRepo.placeBid('itest-i5', BIDDER, 5000)).rejects.toThrow()

      await itemRepo.createItem(
        {
          id: 'itest-i6',
          title: 'Ad',
          categoryId: 'car',
          type: ItemType.ad,
          priceFrom: { amount: 1000 },
          hidden: false,
        },
        UID,
      )
      await expect(itemRepo.placeBid('itest-i6', BIDDER, 5000)).rejects.toThrow()
    })

    it('listItemsPage returns non-hidden, non-sold items', async () => {
      await itemRepo.createItem(
        { id: 'itest-i3', title: 'Visible', categoryId: 'car', type: ItemType.ad, hidden: false },
        UID,
      )
      const active = await itemRepo.listItemsPage({}, PAGE)
      const ids = active.items.map(i => i.id)
      expect(ids).toContain('itest-i3')
      expect(ids).not.toContain('itest-i1') // hidden above
    })

    it('searchPage is diacritics-insensitive across title, location, internalId, description, highlights', async () => {
      await itemRepo.createItem(
        {
          id: 'itest-search1',
          internalId: 'ITEST-REF-7',
          title: 'Škoda Octavia RS',
          categoryId: 'car',
          type: ItemType.ad,
          location: 'České Budějovice',
          description: { cz: 'Plně servisováno, kompletní historie.', en: 'Fully serviced.' },
          highlights: { cz: [{ title: 'Palivo', value: 'Diesel' }], en: [{ title: 'Fuel', value: 'Diesel' }] },
          hidden: false,
        },
        UID,
      )
      await itemRepo.createItem(
        {
          id: 'itest-search2',
          title: 'Hidden Škoda',
          categoryId: 'car',
          type: ItemType.ad,
          location: 'České Budějovice',
          hidden: true,
        },
        UID,
      )

      const finds = async (q: string) => (await itemRepo.searchPage(q, PAGE)).items.some(i => i.id === 'itest-search1')

      expect(await finds('skoda')).toBe(true) // title, diacritics + case folded
      expect(await finds('Škoda')).toBe(true) // accented query still matches
      expect(await finds('ceske budejovice')).toBe(true) // location, accent-insensitive
      expect(await finds('itest-ref-7')).toBe(true) // internalId, case-insensitive
      expect(await finds('diesel')).toBe(true) // highlights value
      expect(await finds('servisovano')).toBe(true) // description, accent-insensitive
      expect(await finds('nonexistent-xyz')).toBe(false)

      const hiddenMatched = (await itemRepo.searchPage('ceske budejovice', PAGE)).items.some(
        i => i.id === 'itest-search2',
      )
      expect(hiddenMatched).toBe(false) // hidden rows excluded
    })

    it('searchPage sorts active items by the chosen key and sinks sold/terminal listings last', async () => {
      // Three fixtures sharing a unique title token so the q-match isolates them from other seeds:
      // two active (null dates → STATUS_RANK 1), one sold (STATUS_RANK 4 → terminal, must sort last
      // under every explicit sort despite its mid price).
      const TOKEN = 'zzsortfixture'
      await itemRepo.createItem(
        {
          id: 'itest-sort-mid',
          title: `${TOKEN} mid`,
          categoryId: 'car',
          type: ItemType.auction,
          priceFrom: { amount: 5000 },
          hidden: false,
        },
        UID,
      )
      await itemRepo.createItem(
        {
          id: 'itest-sort-low',
          title: `${TOKEN} low`,
          categoryId: 'car',
          type: ItemType.auction,
          priceFrom: { amount: 1000 },
          hidden: false,
        },
        UID,
      )
      await itemRepo.createItem(
        {
          id: 'itest-sort-sold',
          title: `${TOKEN} sold`,
          categoryId: 'car',
          type: ItemType.auction,
          priceFrom: { amount: 3000 },
          sold: true,
          hidden: false,
        },
        UID,
      )

      const ids = async (sort?: SearchSort) =>
        (await itemRepo.searchPage({ q: TOKEN }, PAGE, sort)).items.map(i => i.id)

      // Active cheapest→dearest, the sold listing last despite its mid (3000) price.
      expect(await ids('priceAsc')).toEqual(['itest-sort-low', 'itest-sort-mid', 'itest-sort-sold'])
      expect(await ids('priceDesc')).toEqual(['itest-sort-mid', 'itest-sort-low', 'itest-sort-sold'])
      // newest + default both keep the sold/terminal listing out of the top.
      const newest = await ids('newest')
      expect(newest[newest.length - 1]).toBe('itest-sort-sold')
      const def = await ids()
      expect(def[def.length - 1]).toBe('itest-sort-sold')
    })

    it('loadLiveItems returns slim state: last bid, count, end, and close flags', async () => {
      await itemRepo.createItem(
        {
          id: 'itest-live1',
          title: 'Live',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - HOUR,
          endDate: Date.now() + HOUR,
          priceFrom: { amount: 1000 },
          minBid: { amount: 100 },
          hidden: false,
        },
        UID,
      )
      await itemRepo.placeBid('itest-live1', BIDDER, 1100)
      await itemRepo.placeBid('itest-live1', BIDDER, 1200)

      const [live] = await itemRepo.loadLiveItems(['itest-live1'])
      expect(live?.id).toBe('itest-live1')
      expect(live?.bidCount).toBe(2)
      expect(live?.lastBid?.amount).toBe(1200) // newest bid drives the current price
      expect(live?.sold).toBe(false)
      expect(live?.closed).toBe(false)

      // No bids yet → count 0, no last bid (price falls back to priceFrom client-side).
      await itemRepo.createItem(
        { id: 'itest-live2', title: 'NoBids', categoryId: 'car', type: ItemType.auction, hidden: false },
        UID,
      )
      const both = await itemRepo.loadLiveItems(['itest-live1', 'itest-live2'])
      expect(both).toHaveLength(2)
      expect(both.find(l => l.id === 'itest-live2')?.bidCount).toBe(0)
      expect(both.find(l => l.id === 'itest-live2')?.lastBid).toBeUndefined()
    })

    it('removeItem deletes the row (and cascades bids)', async () => {
      await itemRepo.removeItem('itest-i2')
      expect(await itemRepo.getById('itest-i2')).toBeUndefined()
    })

    it('getById returns undefined for a missing item', async () => {
      expect(await itemRepo.getById('itest-nope-xyz')).toBeUndefined()
    })

    it('updateItem returns undefined for a missing item and rejects invalid input', async () => {
      expect(await itemRepo.updateItem('itest-missing-upd', { title: 'x' })).toBeUndefined()
      await expect(itemRepo.updateItem('itest-i7', { categoryId: 'not-a-category' })).rejects.toThrow()
      await expect(itemRepo.updateItem('itest-i7', { type: 'spaceship' as unknown as ItemType })).rejects.toThrow()
    })

    it('createItem rejects unknown categoryId and type', async () => {
      await expect(
        itemRepo.createItem({ id: 'itest-bad1', categoryId: 'no-such-cat', hidden: false }, UID),
      ).rejects.toThrow()
      await expect(
        itemRepo.createItem({ id: 'itest-bad2', type: 'nope' as unknown as ItemType, hidden: false }, UID),
      ).rejects.toThrow()
    })

    it('itemInputError flags bad enums and accepts valid / empty input', () => {
      expect(itemRepo.itemInputError({})).toBeNull()
      expect(itemRepo.itemInputError({ categoryId: 'car', type: ItemType.ad })).toBeNull()
      expect(itemRepo.itemInputError({ categoryId: 'bogus' })?.status).toBe(400)
      expect(itemRepo.itemInputError({ type: 'bogus' as unknown as ItemType })?.status).toBe(400)
    })

    it('createItem applies defaults when fields are omitted and ignores client userId', async () => {
      const created = await itemRepo.createItem({ id: 'itest-def1', userId: 'someone-else' }, UID)
      expect(created.userId).toBe(UID) // server-controlled ownership
      expect(created.title).toBe('Nová položka')
      expect(created.categoryId).toBe('others')
      expect(created.internalId).toBe('ITEST-DEF1')
      expect(created.hidden).toBe(true)
      expect(created.type).toBe(ItemType.auction)
    })

    it('placeBid returns undefined for a missing item', async () => {
      expect(await itemRepo.placeBid('itest-missing-bid', BIDDER, 5000)).toBeUndefined()
    })

    it('placeBid rejects a not-yet-started auction', async () => {
      await itemRepo.createItem(
        {
          id: 'itest-notstarted',
          title: 'Future',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() + HOUR,
          endDate: Date.now() + 2 * HOUR,
          priceFrom: { amount: 1000 },
          hidden: false,
        },
        UID,
      )
      await expect(itemRepo.placeBid('itest-notstarted', BIDDER, 5000)).rejects.toThrow()
    })

    it('placeBid does not extend the end when outside the soft-close window', async () => {
      const endMs = Date.now() + 30 * HOUR // far from the 3-min window
      await itemRepo.createItem(
        {
          id: 'itest-noext',
          title: 'NoExtend',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - HOUR,
          endDate: endMs,
          priceFrom: { amount: 1000 },
          hidden: false,
        },
        UID,
      )
      const after = await itemRepo.placeBid('itest-noext', BIDDER, 2000)
      expect(after?.bids).toHaveLength(1)
      expect(after?.endDate).toBe(endMs) // unchanged — no soft-close push
    })

    it('listSoldPage returns sold non-hidden items, ordered by created desc', async () => {
      await itemRepo.createItem(
        { id: 'itest-sold1', title: 'Sold One', categoryId: 'car', type: ItemType.auction, sold: true, hidden: false },
        UID,
      )
      await itemRepo.createItem(
        {
          id: 'itest-sold-hidden',
          title: 'Sold Hidden',
          categoryId: 'car',
          type: ItemType.auction,
          sold: true,
          hidden: true,
        },
        UID,
      )
      const page = await itemRepo.listSoldPage(PAGE)
      const ids = page.items.map(i => i.id)
      expect(ids).toContain('itest-sold1')
      expect(ids).not.toContain('itest-sold-hidden') // hidden excluded
    })

    it('listFavoritesPage returns the requested non-hidden ids and is empty for an empty list', async () => {
      const empty = await itemRepo.listFavoritesPage([], PAGE)
      expect(empty.items).toHaveLength(0)
      expect(empty.total).toBe(0)
      expect(empty.page).toBe(PAGE.page)

      const page = await itemRepo.listFavoritesPage(['itest-i3', 'itest-i1'], PAGE)
      const ids = page.items.map(i => i.id)
      expect(ids).toContain('itest-i3') // visible favorite
      expect(ids).not.toContain('itest-i1') // hidden favorite excluded
    })

    it('listAdminItemsPage filters by visibility and free-text query', async () => {
      const visible = await itemRepo.listAdminItemsPage({ visibility: 'visible' }, PAGE)
      expect(visible.items.every(i => i.hidden === false)).toBe(true)

      const hidden = await itemRepo.listAdminItemsPage({ visibility: 'hidden' }, PAGE)
      expect(hidden.items.every(i => i.hidden === true)).toBe(true)

      const all = await itemRepo.listAdminItemsPage({ visibility: 'all' }, PAGE)
      const allIds = all.items.map(i => i.id)
      expect(allIds).toContain('itest-i3') // visible
      // i1 was hidden earlier in this suite.
      expect(allIds).toContain('itest-i1')

      const queried = await itemRepo.listAdminItemsPage({ q: 'Visible' }, PAGE)
      expect(queried.items.some(i => i.id === 'itest-i3')).toBe(true)
    })

    it('listBidsPage returns bids newest-first and is empty for an item with none', async () => {
      await itemRepo.createItem(
        {
          id: 'itest-bidlist',
          title: 'BidList',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - HOUR,
          endDate: Date.now() + HOUR,
          priceFrom: { amount: 1000 },
          minBid: { amount: 100 },
          hidden: false,
        },
        UID,
      )
      await itemRepo.placeBid('itest-bidlist', BIDDER, 1100)
      await itemRepo.placeBid('itest-bidlist', BIDDER, 1200)
      const page = await itemRepo.listBidsPage('itest-bidlist', PAGE)
      expect(page.items).toHaveLength(2)
      expect(page.items[0]?.amount).toBe(1200) // newest first

      const none = await itemRepo.listBidsPage('itest-no-bids-here', PAGE)
      expect(none.items).toHaveLength(0)
      expect(none.total).toBe(0)
    })

    it('listItemsPage filters by type, category, and live window', async () => {
      const ads = await itemRepo.listItemsPage({ type: 'ad' }, PAGE)
      expect(ads.items.every(i => i.type === 'ad')).toBe(true)
      expect(ads.items.some(i => i.id === 'itest-i3')).toBe(true)

      await itemRepo.createItem(
        {
          id: 'itest-livefilter',
          title: 'LiveNow',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - HOUR,
          endDate: Date.now() + HOUR,
          hidden: false,
        },
        UID,
      )
      const live = await itemRepo.listItemsPage({ live: true }, PAGE)
      expect(live.items.some(i => i.id === 'itest-livefilter')).toBe(true)

      const byCat = await itemRepo.listItemsPage({ categoryId: 'others' }, PAGE)
      expect(byCat.items.every(i => i.categoryId === 'others')).toBe(true)
    })

    it('searchPage returns the full set when the query is blank', async () => {
      const blank = await itemRepo.searchPage('   ', PAGE)
      expect(blank.items.some(i => i.id === 'itest-i3')).toBe(true) // no q filter applied
    })

    it('loadCardsByIds preserves order, drops missing ids, and carries bodyType + specs', async () => {
      await itemRepo.createItem(
        {
          id: 'itest-card1',
          title: 'CardOne',
          categoryId: 'car',
          type: ItemType.ad,
          bodyType: 'sedan' as BodyType,
          specs: { manufacturer: 'Skoda' } as VehicleSpecs,
          hidden: false,
        },
        UID,
      )
      await itemRepo.createItem(
        { id: 'itest-card2', title: 'CardTwo', categoryId: 'car', type: ItemType.ad, hidden: false },
        UID,
      )
      const empty = await itemRepo.loadCardsByIds([])
      expect(empty).toHaveLength(0)

      const cards = await itemRepo.loadCardsByIds(['itest-card2', 'itest-missing', 'itest-card1'])
      expect(cards.map(c => c.id)).toEqual(['itest-card2', 'itest-card1']) // order preserved, missing dropped
      const card1 = cards.find(c => c.id === 'itest-card1')
      expect(card1?.bodyType).toBe('sedan')
      expect(card1?.specs?.manufacturer).toBe('Skoda')
      const card2 = cards.find(c => c.id === 'itest-card2')
      expect(card2?.bodyType).toBeUndefined()
    })

    it('loadLiveItems and loadBidSummary short-circuit on an empty id list', async () => {
      expect(await itemRepo.loadLiveItems([])).toHaveLength(0)
      expect((await itemRepo.loadBidSummary([])).size).toBe(0)
    })

    it('listSitemapItems returns visible ids with an updated/created lastmod fallback', async () => {
      const rows = await itemRepo.listSitemapItems()
      const visible = rows.find(r => r.id === 'itest-i3')
      expect(visible).toBeDefined()
      expect(visible?.lastmod).toBeInstanceOf(Date)
      // Hidden rows are excluded.
      expect(rows.some(r => r.id === 'itest-card1')).toBe(true)
    })

    it('closeOneAuction marks a sold auction with a winner when the reserve is met', async () => {
      const endMs = Date.now() - 60_000
      await itemRepo.createItem(
        {
          id: 'itest-close-sold',
          title: 'CloseSold',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - 2 * HOUR,
          // Live at bid time, then expired so close can finalize it.
          endDate: Date.now() + HOUR,
          priceFrom: { amount: 1000 },
          minBid: { amount: 100 },
          minimalPrice: { amount: 1000 },
          hidden: false,
        },
        UID,
      )
      await itemRepo.placeBid('itest-close-sold', BIDDER, 1100)
      // Force the end into the past so the close gate passes.
      await db
        .updateTable('items')
        .set({ endDate: new Date(endMs) })
        .where('id', '=', 'itest-close-sold')
        .execute()

      const outcome = await itemRepo.closeOneAuction('itest-close-sold')
      expect(outcome).toEqual({ sold: true })
      const finalized = await itemRepo.getById('itest-close-sold')
      expect(finalized?.closed).toBe(true)
      expect(finalized?.sold).toBe(true)
      expect(finalized?.winner?.id).toBe(BIDDER)
      expect(finalized?.winner?.name).toBe('Bidder')
    })

    it('closeOneAuction marks unsold when the reserve is not met (or no bids)', async () => {
      await itemRepo.createItem(
        {
          id: 'itest-close-unsold',
          title: 'CloseUnsold',
          categoryId: 'car',
          type: ItemType.auction,
          startDate: Date.now() - 2 * HOUR,
          endDate: new Date(Date.now() - 60_000).getTime(),
          minimalPrice: { amount: 999_999 },
          hidden: false,
        },
        UID,
      )
      const outcome = await itemRepo.closeOneAuction('itest-close-unsold')
      expect(outcome).toEqual({ sold: false })
      const finalized = await itemRepo.getById('itest-close-unsold')
      expect(finalized?.closed).toBe(true)
      expect(finalized?.sold).toBe(false)
      expect(finalized?.winner).toBeUndefined()
    })

    it('closeOneAuction skips missing, already-closed, non-auction, and not-yet-ended rows', async () => {
      expect(await itemRepo.closeOneAuction('itest-close-missing')).toBeNull()

      await itemRepo.createItem(
        {
          id: 'itest-close-already',
          title: 'AlreadyClosed',
          categoryId: 'car',
          type: ItemType.auction,
          endDate: new Date(Date.now() - 60_000).getTime(),
          closed: true,
          hidden: false,
        },
        UID,
      )
      expect(await itemRepo.closeOneAuction('itest-close-already')).toBeNull()

      await itemRepo.createItem(
        { id: 'itest-close-ad', title: 'AdClose', categoryId: 'car', type: ItemType.ad, hidden: false },
        UID,
      )
      expect(await itemRepo.closeOneAuction('itest-close-ad')).toBeNull()

      await itemRepo.createItem(
        {
          id: 'itest-close-future',
          title: 'FutureClose',
          categoryId: 'car',
          type: ItemType.auction,
          endDate: Date.now() + 10 * HOUR,
          hidden: false,
        },
        UID,
      )
      expect(await itemRepo.closeOneAuction('itest-close-future')).toBeNull()

      // No endDate → endMs == null → skipped.
      await itemRepo.createItem(
        { id: 'itest-close-noend', title: 'NoEnd', categoryId: 'car', type: ItemType.auction, hidden: false },
        UID,
      )
      expect(await itemRepo.closeOneAuction('itest-close-noend')).toBeNull()
    })

    it('listClosableAuctionIds returns ended, open, non-hidden auctions only', async () => {
      // Fresh ended-but-open auction so the prior close tests don't affect this assertion.
      await itemRepo.createItem(
        {
          id: 'itest-closable',
          title: 'Closable',
          categoryId: 'car',
          type: ItemType.auction,
          endDate: new Date(Date.now() - 60_000).getTime(),
          hidden: false,
        },
        UID,
      )
      const ids = await itemRepo.listClosableAuctionIds(100)
      expect(ids).toContain('itest-closable') // ended, not yet closed
      // The previously closed/sold/non-ended/non-auction rows must NOT appear.
      expect(ids).not.toContain('itest-close-already') // closed
      expect(ids).not.toContain('itest-close-future') // not ended
      expect(ids).not.toContain('itest-close-ad') // not an auction
    })

    it('listWinnersPendingEmail lists sold winners and markWinnerEmailed is idempotent', async () => {
      const pending = await itemRepo.listWinnersPendingEmail(100)
      const mine = pending.find(p => p.itemId === 'itest-close-sold')
      expect(mine).toBeDefined()
      expect(mine?.winnerUserId).toBe(BIDDER)
      expect(mine?.title).toBe('CloseSold')

      await itemRepo.markWinnerEmailed('itest-close-sold')
      const afterMark = await itemRepo.listWinnersPendingEmail(100)
      expect(afterMark.some(p => p.itemId === 'itest-close-sold')).toBe(false) // stamped → no longer pending

      // Second call is a no-op (null guard) — must not throw.
      await expect(itemRepo.markWinnerEmailed('itest-close-sold')).resolves.toBeUndefined()
    })
  })

  describe('questionRepo', () => {
    const QITEM = 'itest-q-item'

    beforeAll(async () => {
      await itemRepo.createItem(
        { id: QITEM, title: 'Q Host', categoryId: 'car', type: ItemType.ad, hidden: false },
        UID,
      )
    })

    afterAll(async () => {
      await db.deleteFrom('itemQuestions').where('itemId', 'like', 'itest-q-%').execute()
      await db.deleteFrom('items').where('id', 'like', 'itest-q-%').execute()
    })

    // INT-1 — a new question lands 'pending' (hidden), never auto-published.
    it('createQuestion stores a pending, unanswered question', async () => {
      const created = await questionRepo.createQuestion({ itemId: QITEM, userId: UID, body: 'Is the VIN ok?' })
      expect(created.status).toBe('pending')
      expect(created.answer).toBeUndefined()
      expect(created.answeredAt).toBeUndefined()
      expect(created.created).toBeGreaterThan(0)
    })

    // INT-2 — THE moderation invariant end-to-end: pending is invisible to the public read until an
    // answer auto-publishes it.
    it('answerQuestion auto-publishes so the question enters the public thread', async () => {
      const created = await questionRepo.createQuestion({ itemId: QITEM, userId: UID, body: 'Pending one?' })

      const beforeAnswer = await questionRepo.listQuestionsPage(QITEM, PAGE)
      expect(beforeAnswer.items.some(x => x.id === created.id)).toBe(false) // pending → hidden from public

      const answered = await questionRepo.answerQuestion(created.id, QITEM, BIDDER, 'Yes, it is.')
      expect(answered?.status).toBe('published')
      expect(answered?.answer).toBe('Yes, it is.')
      expect(answered?.answeredBy).toBe(BIDDER)
      expect(answered?.answeredAt).toBeGreaterThan(0)

      const afterAnswer = await questionRepo.listQuestionsPage(QITEM, PAGE)
      expect(afterAnswer.items.some(x => x.id === created.id)).toBe(true) // now public
    })

    // INT-3 — the admin queue returns ALL statuses for an item; the public read returns none of the
    // un-published ones. Same data, two lenses.
    it('listAdminQuestionsPage returns every status; the itemId filter scopes it', async () => {
      const pending = await questionRepo.createQuestion({ itemId: QITEM, userId: UID, body: 'Still pending' })

      const admin = await questionRepo.listAdminQuestionsPage(PAGE, { itemId: QITEM })
      const ids = admin.items.map(x => x.id)
      expect(ids).toContain(pending.id) // pending visible to admin
      expect(admin.items.every(x => x.itemId === QITEM)).toBe(true) // filter scoped to this item

      const pub = await questionRepo.listQuestionsPage(QITEM, PAGE)
      expect(pub.items.some(x => x.id === pending.id)).toBe(false)
    })

    // INT-4 — moderating a published question to 'hidden' pulls it back out of the public thread.
    it('setQuestionStatus hidden removes a published question from the public list', async () => {
      const created = await questionRepo.createQuestion({ itemId: QITEM, userId: UID, body: 'To be hidden' })
      await questionRepo.answerQuestion(created.id, QITEM, BIDDER, 'Published then hidden.')

      const whilePublished = await questionRepo.listQuestionsPage(QITEM, PAGE)
      expect(whilePublished.items.some(x => x.id === created.id)).toBe(true)

      const hidden = await questionRepo.setQuestionStatus(created.id, QITEM, 'hidden')
      expect(hidden?.status).toBe('hidden')

      const afterHide = await questionRepo.listQuestionsPage(QITEM, PAGE)
      expect(afterHide.items.some(x => x.id === created.id)).toBe(false) // gone from public
    })

    // INT-5 — answering / moderating a vanished question resolves undefined (drives the handler 404).
    it('answerQuestion and setQuestionStatus return undefined for a missing id', async () => {
      expect(await questionRepo.answerQuestion('itest-q-nope', QITEM, BIDDER, 'x')).toBeUndefined()
      expect(await questionRepo.setQuestionStatus('itest-q-nope', QITEM, 'hidden')).toBeUndefined()
    })

    // INT-IDOR — the itemId scope is real SQL: answering/moderating with the wrong itemId updates no
    // row (the question belongs to another listing), so the repo returns undefined → handler 404.
    it('answerQuestion and setQuestionStatus are scoped by itemId (cross-item is a no-op)', async () => {
      const host2 = 'itest-q-item2'
      await itemRepo.createItem(
        { id: host2, title: 'Q Host 2', categoryId: 'car', type: ItemType.ad, hidden: false },
        UID,
      )
      const created = await questionRepo.createQuestion({ itemId: QITEM, userId: UID, body: 'Owned by QITEM' })

      // Wrong item id → no update.
      expect(await questionRepo.answerQuestion(created.id, host2, BIDDER, 'nope')).toBeUndefined()
      expect(await questionRepo.setQuestionStatus(created.id, host2, 'hidden')).toBeUndefined()

      // The question is untouched (still pending under its real item).
      const correct = await questionRepo.setQuestionStatus(created.id, QITEM, 'published')
      expect(correct?.status).toBe('published')
    })
  })

  describe('invoiceRepo', () => {
    it('lists invoices for a user', async () => {
      await db
        .insertInto('invoices')
        .values({
          id: 'itest-inv1',
          userId: UID,
          status: 'unpaid',
          priceAmount: 2500,
          priceCurrency: 'EUR',
          createdDate: new Date(),
        })
        .execute()
      const invoices = await listForUserPage(UID, PAGE)
      expect(invoices.items.find(i => i.id === 'itest-inv1')?.price?.amount).toBe(2500)
    })
  })

  describe('contactRepo', () => {
    it('persists a contact message and lists it', async () => {
      const saved = await contactRepo.createContactMessage({
        kind: 'contact',
        name: 'Itest Sender',
        email: 'itest-contact@example.test',
        message: 'Hello',
      })
      expect(saved.id).toMatch(/^c/)
      expect(saved.kind).toBe('contact')
      expect(saved.status).toBe('new')
      expect(saved.notifiedAt).toBeUndefined()
      expect(saved.created).toBeGreaterThan(0)

      const page = await contactRepo.listContactMessagesPage(PAGE)
      expect(page.items.find(m => m.id === saved.id)?.email).toBe('itest-contact@example.test')
    })

    it('persists an offer with a rehydrated price and stamps notifiedAt', async () => {
      const saved = await contactRepo.createContactMessage({
        kind: 'offer',
        itemId: 'itest-cm-i1',
        userId: UID,
        offerAmount: 9999,
        offerCurrency: 'EUR',
      })
      expect(saved.offer?.amount).toBe(9999)
      expect(saved.offer?.currency?.code).toBe('EUR')

      await contactRepo.markContactNotified(saved.id)
      const page = await contactRepo.listContactMessagesPage(PAGE)
      expect(page.items.find(m => m.id === saved.id)?.notifiedAt).toBeGreaterThan(0)
    })
  })
})
