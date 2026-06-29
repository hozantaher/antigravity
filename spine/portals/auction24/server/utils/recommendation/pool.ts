import { ItemStatus, buildItemVector, type ItemAttrs, type ItemVector } from '~/models'
import * as recoRepo from '../../repos/recommendationRepo'
import type { ItemAttrRow, PoolItemRow, ServingItemFeatures } from '../../repos/recommendationRepo'

// A scored candidate carries just what the math needs (§14: small pool, trivial in-memory
// scoring). Final card payloads are hydrated separately via itemRepo.loadCardsByIds.
export interface ScorableCandidate {
  id: string
  categoryId: string
  countryCode: string | null
  status: ItemStatus
  endMs: number | null
  attrs: ItemAttrs
  vector: ItemVector
  make?: string
}

const num = (v: string | number | null | undefined): number | undefined => (v == null ? undefined : Number(v))

// Item row → attribute snapshot for scoring. Works for active pool rows and arbitrary
// engaged (possibly ended) items, since both share these columns.
export const rowToAttrs = (row: ItemAttrRow): ItemAttrs => ({
  categorical: {
    categoryId: row.categoryId,
    type: row.type,
    make: row.specs?.manufacturer ?? undefined,
    model: row.specs?.model ?? undefined,
    bodyType: row.bodyType ?? undefined,
    fuelType: row.fuelType ?? undefined,
    transmission: row.transmission ?? undefined,
    driveType: row.driveType ?? undefined,
    color: row.color ?? undefined,
    countryCode: row.countryCode ?? undefined,
  },
  numeric: {
    price: num(row.priceFromAmount),
    year: row.specs?.yearOfManufacture ?? undefined,
    enginePowerKw: row.enginePowerKw ?? undefined,
    engineDisplacementCcm: row.engineDisplacementCcm ?? undefined,
  },
})

// Pool is pre-filtered to active rows, so status is always one of the recommendable three.
const poolStatus = (row: PoolItemRow, nowMs: number): ItemStatus => {
  if (row.type === 'ad') return ItemStatus.BuyNow
  const start = row.startDate ? row.startDate.getTime() : 0
  const end = row.endDate ? row.endDate.getTime() : 0
  if (start <= nowMs && end > nowMs) return ItemStatus.AuctionLive
  if (start > nowMs) return ItemStatus.AuctionSoon
  return ItemStatus.AuctionEnd
}

export const poolRowToCandidate = (row: PoolItemRow, nowMs: number): ScorableCandidate => {
  const attrs = rowToAttrs(row)
  return {
    id: row.id,
    categoryId: row.categoryId,
    countryCode: row.countryCode,
    status: poolStatus(row, nowMs),
    endMs: row.endDate ? row.endDate.getTime() : null,
    attrs,
    vector: buildItemVector(attrs),
    make: row.specs?.manufacturer ?? undefined,
  }
}

// Module-level TTL cache (mirrors rateLimit.ts) — keeps DB load flat regardless of QPS:
// the active pool is shared, so all serving requests in a window reuse one snapshot.
const TTL_MS = 45_000
let cache: { at: number; pool: ScorableCandidate[] } | null = null
// The item_features map (pop/trend/quality per pool item) is rebuilt by the same cron and changes
// on the same cadence as the pool, so co-cache it with the same TTL instead of re-running a
// whole-pool `WHERE item_id IN (...)` query on every serving request (home rail + every detail rail).
let featuresCache: { at: number; map: Map<string, ServingItemFeatures> } | null = null

export const getScorablePool = async (nowMs: number): Promise<ScorableCandidate[]> => {
  if (cache && nowMs - cache.at < TTL_MS) return cache.pool
  const rows = await recoRepo.loadActivePool()
  const pool = rows.map(r => poolRowToCandidate(r, nowMs))
  cache = { at: nowMs, pool }
  return pool
}

// Cached pop/trend/quality features for the current pool, shared across serving requests in a window.
export const getServingFeatures = async (nowMs: number): Promise<Map<string, ServingItemFeatures>> => {
  if (featuresCache && nowMs - featuresCache.at < TTL_MS) return featuresCache.map
  const pool = await getScorablePool(nowMs)
  const map = await recoRepo.getItemFeaturesMap(pool.map(c => c.id))
  featuresCache = { at: nowMs, map }
  return map
}

export const invalidatePoolCache = (): void => {
  cache = null
  featuresCache = null
}
