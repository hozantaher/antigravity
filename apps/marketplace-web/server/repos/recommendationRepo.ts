import { sql } from 'kysely'
import type { PopularityRankingEntry, VehicleSpecs } from '~/models'
import { db } from '../utils/db'
import type {
  AttributeAffinityInsert,
  ItemFeaturesInsert,
  RecommendationEventInsert,
  VisitorProfileInsert,
} from '../db/schema'

// Data access for the recommendation engine (docs/recommendation-algorithm.md §4).
// Aggregation/scoring lives in server/utils/recommendation + models/Recommendation;
// this layer only reads/writes. Numeric columns come back as strings → Number() them.

// pg serializes a JS array as a Postgres array literal, not JSON — so arrays bound for a
// jsonb column must be pre-stringified (objects are fine: pg JSON-stringifies plain objects).
const jsonbArray = <T>(v: T[]): T[] => JSON.stringify(v) as unknown as T[]

// ── Ingest (POST /api/track) ───────────────────────────────────────────────────
export const insertEventsBatch = async (events: RecommendationEventInsert[]): Promise<void> => {
  if (events.length === 0) return
  // PK (id = client UUID) makes the append idempotent across beacon retries.
  await db
    .insertInto('recommendationEvents')
    .values(events)
    .onConflict(oc => oc.column('id').doNothing())
    .execute()
}

// ── Active scorable pool ───────────────────────────────────────────────────────
export interface PoolItemRow {
  id: string
  categoryId: string
  type: 'auction' | 'ad'
  countryCode: string | null
  startDate: Date | null
  endDate: Date | null
  priceFromAmount: string | null
  bodyType: string | null
  fuelType: string | null
  transmission: string | null
  driveType: string | null
  color: string | null
  enginePowerKw: number | null
  engineDisplacementCcm: number | null
  specs: VehicleSpecs | null
  images: string[]
  images360: string[]
  priceHighlighted: boolean
  description: Record<string, string> | null
}

const POOL_COLUMNS = [
  'id',
  'categoryId',
  'type',
  'countryCode',
  'startDate',
  'endDate',
  'priceFromAmount',
  'bodyType',
  'fuelType',
  'transmission',
  'driveType',
  'color',
  'enginePowerKw',
  'engineDisplacementCcm',
  'specs',
  'images',
  'images360',
  'priceHighlighted',
  'description',
] as const

// Active = not sold/hidden and (a buy-now ad OR an auction not yet ended). Soft "soon"
// auctions are kept (they are recommendable, §8). Closed/ended auctions fall out via end_date.
export const loadActivePool = (): Promise<PoolItemRow[]> =>
  db
    .selectFrom('items')
    .select(POOL_COLUMNS)
    .where('sold', '=', false)
    .where('hidden', '=', false)
    .where(sql<boolean>`type = 'ad' or (end_date is not null and end_date > now())`)
    .execute()

// Attribute rows for arbitrary (possibly ended) engaged items — profile building.
export type ItemAttrRow = Pick<
  PoolItemRow,
  | 'id'
  | 'categoryId'
  | 'type'
  | 'countryCode'
  | 'priceFromAmount'
  | 'bodyType'
  | 'fuelType'
  | 'transmission'
  | 'driveType'
  | 'color'
  | 'enginePowerKw'
  | 'engineDisplacementCcm'
  | 'specs'
>

export const loadItemAttrs = async (ids: string[]): Promise<Map<string, ItemAttrRow>> => {
  const map = new Map<string, ItemAttrRow>()
  if (ids.length === 0) return map
  const rows = await db
    .selectFrom('items')
    .select([
      'id',
      'categoryId',
      'type',
      'countryCode',
      'priceFromAmount',
      'bodyType',
      'fuelType',
      'transmission',
      'driveType',
      'color',
      'enginePowerKw',
      'engineDisplacementCcm',
      'specs',
    ])
    .where('id', 'in', ids)
    .execute()
  for (const r of rows) map.set(r.id, r)
  return map
}

// ── Build inputs: events + bootstrap signals (§3.5) ────────────────────────────
export interface BuildEventRow {
  vid: string
  userId: string | null
  sessionId: string | null
  type: string
  itemId: string
  value: string | null
  occurredAt: Date
}

export const loadEventWindow = (sinceMs: number): Promise<BuildEventRow[]> =>
  db
    .selectFrom('recommendationEvents')
    .select(['vid', 'userId', 'sessionId', 'type', 'itemId', 'value', 'occurredAt'])
    .where('occurredAt', '>', new Date(sinceMs))
    .where('itemId', 'is not', null)
    .$narrowType<{ itemId: string }>()
    .execute()

export const listFavoriteSignals = async (): Promise<Array<{ userId: string; itemId: string }>> => {
  const res = await sql<{ userId: string; itemId: string }>`
    select id as user_id, fid as item_id
    from users, unnest(favorite_ids) as fid
    where deleted_at is null
  `.execute(db)
  return res.rows
}

export const listBidSignals = (sinceMs: number): Promise<Array<{ userId: string; itemId: string; date: Date }>> =>
  db.selectFrom('bids').select(['userId', 'itemId', 'date']).where('date', '>', new Date(sinceMs)).execute()

export const listContactSignals = async (
  sinceMs: number,
): Promise<Array<{ userId: string; itemId: string; kind: 'contact' | 'offer'; created: Date }>> => {
  const rows = await db
    .selectFrom('contactMessages')
    .select(['userId', 'itemId', 'kind', 'created'])
    .where('userId', 'is not', null)
    .where('itemId', 'is not', null)
    .where('created', '>', new Date(sinceMs))
    .execute()
  return rows.flatMap(r =>
    r.userId && r.itemId ? [{ userId: r.userId, itemId: r.itemId, kind: r.kind, created: r.created }] : [],
  )
}

export const loadBidCounts = async (ids: string[]): Promise<Map<string, number>> => {
  const map = new Map<string, number>()
  if (ids.length === 0) return map
  const rows = await db
    .selectFrom('bids')
    .select(['itemId'])
    .select(sql<string>`count(*)`.as('cnt'))
    .where('itemId', 'in', ids)
    .groupBy('itemId')
    .execute()
  for (const r of rows) map.set(r.itemId, Number(r.cnt))
  return map
}

// Favorite counts for the active pool only (mirrors loadBidCounts(ids)). The `favorite_ids && ids`
// overlap prunes users with no pool favorite before the unnest expands, and `fid = any(ids)` keeps
// only pool items in the group — so the build no longer scans + unnests the entire users table.
export const loadFavoriteCounts = async (ids: string[]): Promise<Map<string, number>> => {
  const map = new Map<string, number>()
  if (ids.length === 0) return map
  const res = await sql<{ itemId: string; cnt: string }>`
    select fid as item_id, count(*) as cnt
    from users, unnest(favorite_ids) as fid
    where favorite_ids && ${ids} and fid = any(${ids})
    group by fid
  `.execute(db)
  for (const r of res.rows) map.set(r.itemId, Number(r.cnt))
  return map
}

// ── Precompute upserts ─────────────────────────────────────────────────────────
export const upsertItemFeaturesBatch = async (rows: ItemFeaturesInsert[]): Promise<void> => {
  if (rows.length === 0) return
  // Chunk to stay well under Postgres' 65535 bound-parameter cap (8 params/row ⇒ ~8191-row ceiling);
  // a larger active pool would otherwise throw and silently stall the whole features/popularity pass.
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insertInto('itemFeatures')
      .values(rows.slice(i, i + 500))
      .onConflict(oc =>
        oc.column('itemId').doUpdateSet(eb => ({
          vector: eb.ref('excluded.vector'),
          popScore: eb.ref('excluded.popScore'),
          trendScore: eb.ref('excluded.trendScore'),
          engagementSum: eb.ref('excluded.engagementSum'),
          impressionCount: eb.ref('excluded.impressionCount'),
          distinctViewers: eb.ref('excluded.distinctViewers'),
          qualityScore: eb.ref('excluded.qualityScore'),
          updatedAt: sql`now()`,
        })),
      )
      .execute()
  }
}

export const upsertVisitorProfilesBatch = async (rows: VisitorProfileInsert[]): Promise<void> => {
  if (rows.length === 0) return
  // Chunk to stay well under Postgres' 65535 bound parameters.
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insertInto('visitorProfiles')
      .values(
        rows
          .slice(i, i + 500)
          .map(r => ({ ...r, topMakes: jsonbArray((r.topMakes ?? []) as Array<[string, number]>) })),
      )
      .onConflict(oc =>
        oc.column('vid').doUpdateSet(eb => ({
          userId: eb.ref('excluded.userId'),
          features: eb.ref('excluded.features'),
          topMakes: eb.ref('excluded.topMakes'),
          nEff: eb.ref('excluded.nEff'),
          alpha: eb.ref('excluded.alpha'),
          lastEventAt: eb.ref('excluded.lastEventAt'),
          updatedAt: sql`now()`,
        })),
      )
      .execute()
  }
}

// Popularity segment keys (§9.3) — a single writer (build) / reader (serve) contract. Country
// is lower-cased here so the two sides can't drift on casing.
export const GLOBAL_SEGMENT = 'global'
export const popularitySegmentKey = (dim: 'cat' | 'country', value: string): string =>
  `${dim}:${dim === 'country' ? value.toLowerCase() : value}`

export const upsertPopularitySegment = async (segmentKey: string, ranking: PopularityRankingEntry[]): Promise<void> => {
  await db
    .insertInto('popularitySegments')
    .values({ segmentKey, ranking: jsonbArray(ranking) })
    .onConflict(oc =>
      oc.column('segmentKey').doUpdateSet(eb => ({ ranking: eb.ref('excluded.ranking'), updatedAt: sql`now()` })),
    )
    .execute()
}

// Atomic per-dimension swap: delete the dimension's rows + insert the fresh top-K.
export const replaceAttributeAffinity = (dimension: string, rows: AttributeAffinityInsert[]): Promise<void> =>
  db.transaction().execute(async trx => {
    await trx.deleteFrom('attributeAffinity').where('dimension', '=', dimension).execute()
    if (rows.length > 0) await trx.insertInto('attributeAffinity').values(rows).execute()
  })

// ── Serving reads ──────────────────────────────────────────────────────────────
export interface ServingProfile {
  features: import('~/models').VisitorFeatureVector
  alpha: number
}

export const getVisitorProfile = async (vid: string): Promise<ServingProfile | undefined> => {
  const row = await db
    .selectFrom('visitorProfiles')
    .select(['features', 'alpha'])
    .where('vid', '=', vid)
    .executeTakeFirst()
  return row ? { features: row.features, alpha: Number(row.alpha) } : undefined
}

export interface ServingItemFeatures {
  popScore: number
  trendScore: number
  qualityScore: number
}

export const getItemFeaturesMap = async (ids: string[]): Promise<Map<string, ServingItemFeatures>> => {
  const map = new Map<string, ServingItemFeatures>()
  if (ids.length === 0) return map
  const rows = await db
    .selectFrom('itemFeatures')
    .select(['itemId', 'popScore', 'trendScore', 'qualityScore'])
    .where('itemId', 'in', ids)
    .execute()
  for (const r of rows)
    map.set(r.itemId, {
      popScore: Number(r.popScore),
      trendScore: Number(r.trendScore),
      qualityScore: Number(r.qualityScore),
    })
  return map
}

export const getPopularitySegment = async (segmentKey: string): Promise<PopularityRankingEntry[]> => {
  const row = await db
    .selectFrom('popularitySegments')
    .select('ranking')
    .where('segmentKey', '=', segmentKey)
    .executeTakeFirst()
  return row?.ranking ?? []
}

// Neighbor scores for the anchor's attribute values, grouped by dimension →
// (neighbor value → score). Drives attrAffinity(anchor, candidate) on the hot path.
export const loadAnchorAffinity = async (
  pairs: Array<{ dimension: string; value: string }>,
): Promise<Map<string, Map<string, number>>> => {
  const out = new Map<string, Map<string, number>>()
  if (pairs.length === 0) return out
  const rows = await db
    .selectFrom('attributeAffinity')
    .select(['dimension', 'valueA', 'valueB', 'score'])
    .where(eb => eb.or(pairs.map(p => eb.and([eb('dimension', '=', p.dimension), eb('valueA', '=', p.value)]))))
    .execute()
  for (const r of rows) {
    const m = out.get(r.dimension) ?? new Map<string, number>()
    m.set(r.valueB, Number(r.score))
    out.set(r.dimension, m)
  }
  return out
}

// Items the user already converted on (favorites ∪ own bids) — never re-recommend (§8).
export const getConvertedItemIds = async (userId: string): Promise<Set<string>> => {
  const [fav, bids] = await Promise.all([
    db.selectFrom('users').select('favoriteIds').where('id', '=', userId).executeTakeFirst(),
    db.selectFrom('bids').select('itemId').distinct().where('userId', '=', userId).execute(),
  ])
  const set = new Set<string>(fav?.favoriteIds ?? [])
  for (const b of bids) set.add(b.itemId)
  return set
}

// ── Maintenance ────────────────────────────────────────────────────────────────
export const pruneEvents = async (cutoffMs: number): Promise<number> => {
  const res = await db
    .deleteFrom('recommendationEvents')
    .where('occurredAt', '<', new Date(cutoffMs))
    .executeTakeFirst()
  return Number(res.numDeletedRows ?? 0)
}

export const pruneStaleProfiles = async (cutoffMs: number): Promise<number> => {
  const res = await db
    .deleteFrom('visitorProfiles')
    .where('lastEventAt', 'is not', null)
    .where('lastEventAt', '<', new Date(cutoffMs))
    .executeTakeFirst()
  return Number(res.numDeletedRows ?? 0)
}

// Freshness of the heavy precompute pass — gates the hourly profile/affinity rebuild.
export const getProfilesFreshness = async (): Promise<Date | null> => {
  const row = await db
    .selectFrom('visitorProfiles')
    .select(sql<Date | null>`max(updated_at)`.as('maxUpdatedAt'))
    .executeTakeFirst()
  return row?.maxUpdatedAt ?? null
}
