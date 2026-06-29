import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import * as recoRepo from '~/server/repos/recommendationRepo'
import type {
  AttributeAffinityInsert,
  ItemFeaturesInsert,
  RecommendationEventInsert,
  VisitorProfileInsert,
} from '~/server/db/schema'

const RUN = !!process.env.POSTGRES_URL

// Unique prefix so concurrent test files never collide; all assertions are id-scoped.
const P = 'rtest-'
const U1 = `${P}u1`
const U2 = `${P}u2`
const I1 = `${P}i1` // active auction, future end
const I2 = `${P}i2` // active ad
const I3 = `${P}i3` // ended auction (falls out of pool)
const I4 = `${P}i4` // hidden (falls out of pool)
const VID1 = `${P}vid1`
const VID2 = `${P}vid2`
const CAT = 'car' // items.category_id has a check constraint against the known category ids
const SEG_CAT = recoRepo.popularitySegmentKey('cat', CAT)
const SEG_COUNTRY = recoRepo.popularitySegmentKey('country', 'CZ')
const DIM = `${P}dim`

const HOUR = 3600_000

const cleanup = async () => {
  await db.deleteFrom('recommendationEvents').where('id', 'like', `${P}%`).execute()
  await db.deleteFrom('recommendationEvents').where('vid', 'like', `${P}%`).execute()
  await db.deleteFrom('visitorProfiles').where('vid', 'like', `${P}%`).execute()
  await db.deleteFrom('itemFeatures').where('itemId', 'like', `${P}%`).execute()
  await db.deleteFrom('attributeAffinity').where('dimension', '=', DIM).execute()
  await db.deleteFrom('popularitySegments').where('segmentKey', 'in', [SEG_CAT, SEG_COUNTRY]).execute()
  await db.deleteFrom('bids').where('itemId', 'like', `${P}%`).execute()
  await db
    .deleteFrom('contactMessages')
    .where(eb => eb.or([eb('email', 'like', `${P}%`), eb('itemId', 'like', `${P}%`)]))
    .execute()
  await db.deleteFrom('items').where('id', 'like', `${P}%`).execute()
  await db.deleteFrom('users').where('id', 'like', `${P}%`).execute()
}

const insertItem = (id: string, overrides: Record<string, unknown> = {}) =>
  db
    .insertInto('items')
    .values({
      id,
      title: `Item ${id}`,
      image: '',
      categoryId: CAT,
      userId: U1,
      type: 'auction',
      countryCode: 'CZ',
      priceFromAmount: '1000',
      bodyType: 'sedan',
      fuelType: 'diesel',
      transmission: 'manual',
      driveType: 'fwd',
      color: 'black',
      enginePowerKw: 110,
      engineDisplacementCcm: 1968,
      specs: { manufacturer: 'Skoda' } as never,
      images: ['a.jpg'],
      images360: [],
      priceHighlighted: true,
      description: { cz: 'popis' } as never,
      startDate: new Date(Date.now() - HOUR),
      endDate: new Date(Date.now() + HOUR),
      hidden: false,
      sold: false,
      ...overrides,
    })
    .execute()

describe.skipIf(!RUN)('recommendationRepo (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await db
      .insertInto('users')
      .values([
        { id: U1, authType: 'email', fullName: 'R1', email: `${P}u1@example.test`, favoriteIds: [I1, I2] },
        { id: U2, authType: 'email', fullName: 'R2', email: `${P}u2@example.test`, favoriteIds: [] },
      ])
      .execute()
    await insertItem(I1)
    await insertItem(I2, { type: 'ad', endDate: null, startDate: null })
    await insertItem(I3, {
      type: 'auction',
      startDate: new Date(Date.now() - 2 * HOUR),
      endDate: new Date(Date.now() - HOUR),
    })
    // Hidden ad (null end_date) — excluded by the hidden filter on the buy-now branch.
    await insertItem(I4, { hidden: true, type: 'ad', endDate: null, startDate: null })
  })
  afterAll(cleanup)

  // ── Ingest ──────────────────────────────────────────────────────────────────
  describe('insertEventsBatch', () => {
    it('is a no-op on an empty batch', async () => {
      await expect(recoRepo.insertEventsBatch([])).resolves.toBeUndefined()
    })

    it('inserts events and is idempotent on the id PK', async () => {
      const ev: RecommendationEventInsert = {
        id: `${P}e1`,
        vid: VID1,
        userId: U1,
        sessionId: `${P}s1`,
        type: 'detail_view',
        itemId: I1,
        categoryId: CAT,
        value: '1',
        surface: 'detail',
        position: 0,
        propensity: '0.5',
        meta: { make: 'Skoda' } as never,
        occurredAt: new Date(),
      }
      await recoRepo.insertEventsBatch([ev])
      // Replay with the same id but different type — conflict-do-nothing keeps the original.
      await recoRepo.insertEventsBatch([{ ...ev, type: 'changed' }])
      const rows = await db
        .selectFrom('recommendationEvents')
        .select(['id', 'type'])
        .where('id', '=', `${P}e1`)
        .execute()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.type).toBe('detail_view')
    })
  })

  // ── Active pool ───────────────────────────────────────────────────────────────
  describe('loadActivePool', () => {
    it('returns active items (ad + live auction), excludes ended/hidden/sold', async () => {
      const pool = await recoRepo.loadActivePool()
      const ids = pool.map(r => r.id)
      expect(ids).toContain(I1) // live auction
      expect(ids).toContain(I2) // ad
      expect(ids).not.toContain(I3) // ended auction
      expect(ids).not.toContain(I4) // hidden ad
      const row = pool.find(r => r.id === I1)
      expect(row?.specs?.manufacturer).toBe('Skoda')
      expect(row?.images).toEqual(['a.jpg'])
      expect(row?.priceHighlighted).toBe(true)
    })
  })

  // ── loadItemAttrs ───────────────────────────────────────────────────────────
  describe('loadItemAttrs', () => {
    it('returns an empty map for no ids', async () => {
      const map = await recoRepo.loadItemAttrs([])
      expect(map.size).toBe(0)
    })

    it('maps requested ids (including ended ones)', async () => {
      const map = await recoRepo.loadItemAttrs([I1, I3, `${P}missing`])
      expect(map.size).toBe(2)
      expect(map.get(I1)?.bodyType).toBe('sedan')
      expect(map.get(I3)?.fuelType).toBe('diesel')
    })
  })

  // ── Build inputs ──────────────────────────────────────────────────────────────
  describe('loadEventWindow', () => {
    it('returns recent events with a non-null itemId', async () => {
      await db
        .insertInto('recommendationEvents')
        .values([
          {
            id: `${P}e-old`,
            vid: VID1,
            type: 'detail_view',
            itemId: I1,
            occurredAt: new Date(Date.now() - 10 * HOUR),
          },
          {
            id: `${P}e-noitem`,
            vid: VID1,
            type: 'search',
            itemId: null,
            occurredAt: new Date(),
          },
        ])
        .execute()
      const rows = await recoRepo.loadEventWindow(Date.now() - HOUR)
      const ours = rows.filter(r => r.vid === VID1)
      const ids = ours.map(r => r.itemId)
      expect(ids).toContain(I1) // the `${P}e1` event from the ingest test
      expect(ours.every(r => r.itemId !== null)).toBe(true)
      // The 10h-old event is outside the window.
      expect(ours.some(r => r.occurredAt.getTime() < Date.now() - 5 * HOUR)).toBe(false)
    })
  })

  describe('listFavoriteSignals', () => {
    it('unnests favorite_ids for non-deleted users', async () => {
      const rows = await recoRepo.listFavoriteSignals()
      const ours = rows.filter(r => r.userId === U1)
      expect(ours.map(r => r.itemId).sort()).toEqual([I1, I2].sort())
    })
  })

  describe('listBidSignals', () => {
    it('returns recent bids only', async () => {
      await db
        .insertInto('bids')
        .values([
          { itemId: I1, userId: U1, amount: '1500', date: new Date() },
          { itemId: I3, userId: U2, amount: '900', date: new Date(Date.now() - 10 * HOUR) },
        ])
        .execute()
      const rows = await recoRepo.listBidSignals(Date.now() - HOUR)
      const ours = rows.filter(r => r.itemId.startsWith(P))
      expect(ours.map(r => r.itemId)).toContain(I1)
      expect(ours.map(r => r.itemId)).not.toContain(I3) // outside window
    })
  })

  describe('listContactSignals', () => {
    it('returns offer/contact signals with non-null user+item in window', async () => {
      await db
        .insertInto('contactMessages')
        .values([
          { id: `${P}cm1`, kind: 'offer', userId: U1, itemId: I1, email: `${P}cm1@x.test`, created: new Date() },
          { id: `${P}cm2`, kind: 'contact', userId: null, itemId: I2, email: `${P}cm2@x.test`, created: new Date() },
          {
            id: `${P}cm3`,
            kind: 'contact',
            userId: U2,
            itemId: I2,
            email: `${P}cm3@x.test`,
            created: new Date(Date.now() - 10 * HOUR),
          },
        ])
        .execute()
      const rows = await recoRepo.listContactSignals(Date.now() - HOUR)
      const ours = rows.filter(r => r.itemId.startsWith(P))
      expect(ours).toHaveLength(1)
      expect(ours[0]?.kind).toBe('offer')
      expect(ours[0]?.userId).toBe(U1)
    })
  })

  describe('loadBidCounts', () => {
    it('returns an empty map for no ids', async () => {
      const map = await recoRepo.loadBidCounts([])
      expect(map.size).toBe(0)
    })

    it('counts bids per item', async () => {
      const map = await recoRepo.loadBidCounts([I1, I3, I2])
      expect(map.get(I1)).toBe(1)
      expect(map.get(I3)).toBe(1)
      expect(map.get(I2)).toBeUndefined() // no bids
    })
  })

  describe('loadFavoriteCounts', () => {
    it('counts favorites for the requested pool ids', async () => {
      const map = await recoRepo.loadFavoriteCounts([I1, I2])
      expect(map.get(I1)).toBeGreaterThanOrEqual(1)
      expect(map.get(I2)).toBeGreaterThanOrEqual(1)
    })

    it('short-circuits to an empty map when no ids are given', async () => {
      expect(await recoRepo.loadFavoriteCounts([])).toEqual(new Map())
    })
  })

  // ── Precompute upserts ──────────────────────────────────────────────────────
  describe('upsertItemFeaturesBatch', () => {
    it('is a no-op on empty', async () => {
      await expect(recoRepo.upsertItemFeaturesBatch([])).resolves.toBeUndefined()
    })

    it('inserts then updates on conflict', async () => {
      const row: ItemFeaturesInsert = {
        itemId: I1,
        vector: { cat: 1 } as never,
        popScore: '0.1',
        trendScore: '0.2',
        engagementSum: '3',
        impressionCount: '10',
        distinctViewers: 5,
        qualityScore: '0.9',
      }
      await recoRepo.upsertItemFeaturesBatch([row])
      await recoRepo.upsertItemFeaturesBatch([{ ...row, popScore: '0.55' }])
      const map = await recoRepo.getItemFeaturesMap([I1])
      expect(map.get(I1)?.popScore).toBeCloseTo(0.55)
      expect(map.get(I1)?.qualityScore).toBeCloseTo(0.9)
    })
  })

  describe('upsertVisitorProfilesBatch', () => {
    it('is a no-op on empty', async () => {
      await expect(recoRepo.upsertVisitorProfilesBatch([])).resolves.toBeUndefined()
    })

    it('inserts then updates on conflict (topMakes null-coalesced + jsonb array)', async () => {
      const features = { categorical: { make: { Skoda: 1 } }, numeric: {} }
      const base: VisitorProfileInsert = {
        vid: VID1,
        userId: U1,
        features: features as never,
        topMakes: undefined as never, // exercises the `?? []` branch
        nEff: '2',
        alpha: '0.3',
        lastEventAt: new Date(),
      }
      await recoRepo.upsertVisitorProfilesBatch([base])
      await recoRepo.upsertVisitorProfilesBatch([{ ...base, alpha: '0.7', topMakes: [['Skoda', 3]] as never }])
      const prof = await recoRepo.getVisitorProfile(VID1)
      expect(prof?.alpha).toBeCloseTo(0.7)
      expect(prof?.features.categorical.make?.Skoda).toBe(1)
    })

    it('chunks batches larger than 500 rows', async () => {
      const rows: VisitorProfileInsert[] = Array.from({ length: 501 }, (_, i) => ({
        vid: `${P}bulk-${i}`,
        userId: null,
        features: { categorical: {}, numeric: {} } as never,
        topMakes: [] as never,
        nEff: '1',
        alpha: '0.1',
        lastEventAt: new Date(),
      }))
      await recoRepo.upsertVisitorProfilesBatch(rows)
      const count = await db
        .selectFrom('visitorProfiles')
        .select(db.fn.countAll().as('c'))
        .where('vid', 'like', `${P}bulk-%`)
        .executeTakeFirst()
      expect(Number(count?.c)).toBe(501)
    })
  })

  describe('popularitySegmentKey', () => {
    it('lower-cases country, leaves category as-is', () => {
      expect(recoRepo.popularitySegmentKey('country', 'CZ')).toBe('country:cz')
      expect(recoRepo.popularitySegmentKey('cat', 'Car')).toBe('cat:Car')
      expect(recoRepo.GLOBAL_SEGMENT).toBe('global')
    })
  })

  describe('upsertPopularitySegment / getPopularitySegment', () => {
    it('returns empty for an unknown segment', async () => {
      expect(await recoRepo.getPopularitySegment(`${P}nope`)).toEqual([])
    })

    it('inserts then updates ranking on conflict', async () => {
      await recoRepo.upsertPopularitySegment(SEG_CAT, [{ itemId: I1, score: 0.9 }])
      let r = await recoRepo.getPopularitySegment(SEG_CAT)
      expect(r).toEqual([{ itemId: I1, score: 0.9 }])
      await recoRepo.upsertPopularitySegment(SEG_CAT, [
        { itemId: I2, score: 0.8 },
        { itemId: I1, score: 0.5 },
      ])
      r = await recoRepo.getPopularitySegment(SEG_CAT)
      expect(r).toHaveLength(2)
      expect(r[0]?.itemId).toBe(I2)
    })
  })

  describe('replaceAttributeAffinity / loadAnchorAffinity', () => {
    it('handles an empty replace (delete-only, no insert)', async () => {
      await recoRepo.replaceAttributeAffinity(DIM, [])
      const out = await recoRepo.loadAnchorAffinity([{ dimension: DIM, value: 'sedan' }])
      expect(out.size).toBe(0)
    })

    it('returns empty map for no pairs', async () => {
      const out = await recoRepo.loadAnchorAffinity([])
      expect(out.size).toBe(0)
    })

    it('swaps rows atomically and reads neighbor scores', async () => {
      const rows: AttributeAffinityInsert[] = [
        { dimension: DIM, valueA: 'sedan', valueB: 'wagon', score: '0.8' },
        { dimension: DIM, valueA: 'sedan', valueB: 'suv', score: '0.4' },
      ]
      await recoRepo.replaceAttributeAffinity(DIM, rows)
      const out = await recoRepo.loadAnchorAffinity([{ dimension: DIM, value: 'sedan' }])
      expect(out.get(DIM)?.get('wagon')).toBeCloseTo(0.8)
      expect(out.get(DIM)?.get('suv')).toBeCloseTo(0.4)

      // Re-running replaces (no duplicate rows).
      await recoRepo.replaceAttributeAffinity(DIM, [{ dimension: DIM, valueA: 'sedan', valueB: 'wagon', score: '0.9' }])
      const out2 = await recoRepo.loadAnchorAffinity([{ dimension: DIM, value: 'sedan' }])
      expect(out2.get(DIM)?.size).toBe(1)
      expect(out2.get(DIM)?.get('wagon')).toBeCloseTo(0.9)
    })
  })

  // ── Serving reads ─────────────────────────────────────────────────────────────
  describe('getVisitorProfile', () => {
    it('returns undefined for an unknown vid', async () => {
      expect(await recoRepo.getVisitorProfile(`${P}unknown`)).toBeUndefined()
    })
  })

  describe('getItemFeaturesMap', () => {
    it('returns an empty map for no ids', async () => {
      const map = await recoRepo.getItemFeaturesMap([])
      expect(map.size).toBe(0)
    })
  })

  describe('getConvertedItemIds', () => {
    it('unions favorites and own bids', async () => {
      const set = await recoRepo.getConvertedItemIds(U1)
      expect(set.has(I1)).toBe(true) // favorite + bid
      expect(set.has(I2)).toBe(true) // favorite
    })

    it('handles a user with no favorites/bids', async () => {
      const set = await recoRepo.getConvertedItemIds(`${P}ghost`)
      expect(set.size).toBe(0)
    })
  })

  // ── Maintenance ──────────────────────────────────────────────────────────────
  describe('pruneEvents', () => {
    it('deletes events older than the cutoff', async () => {
      await db
        .insertInto('recommendationEvents')
        .values({ id: `${P}prune1`, vid: VID2, type: 'x', itemId: I1, occurredAt: new Date(Date.now() - 100 * HOUR) })
        .execute()
      const n = await recoRepo.pruneEvents(Date.now() - 50 * HOUR)
      expect(n).toBeGreaterThanOrEqual(1)
      const left = await db
        .selectFrom('recommendationEvents')
        .select('id')
        .where('id', '=', `${P}prune1`)
        .executeTakeFirst()
      expect(left).toBeUndefined()
    })
  })

  describe('pruneStaleProfiles', () => {
    it('deletes profiles with a stale lastEventAt', async () => {
      await recoRepo.upsertVisitorProfilesBatch([
        {
          vid: VID2,
          userId: null,
          features: { categorical: {}, numeric: {} } as never,
          topMakes: [] as never,
          nEff: '1',
          alpha: '0.1',
          lastEventAt: new Date(Date.now() - 100 * HOUR),
        },
      ])
      const n = await recoRepo.pruneStaleProfiles(Date.now() - 50 * HOUR)
      expect(n).toBeGreaterThanOrEqual(1)
      expect(await recoRepo.getVisitorProfile(VID2)).toBeUndefined()
    })
  })

  describe('getProfilesFreshness', () => {
    it('returns the max updatedAt across profiles', async () => {
      await recoRepo.upsertVisitorProfilesBatch([
        {
          vid: VID1,
          userId: U1,
          features: { categorical: {}, numeric: {} } as never,
          topMakes: [] as never,
          nEff: '1',
          alpha: '0.1',
          lastEventAt: new Date(),
        },
      ])
      const fresh = await recoRepo.getProfilesFreshness()
      expect(fresh).toBeInstanceOf(Date)
    })
  })
})
