import {
  AFFINITY_DIMS,
  ageInDays,
  aggregateEngagement,
  buildItemVector,
  buildVisitorProfile,
  confidence,
  decayFactor,
  effectiveEvidence,
  popCombine,
  popRate,
  RECO_CONFIG,
  signalContribution,
  topMakes,
  type EngagedItem,
  type EngagementEvent,
  type PopularityRankingEntry,
  type RecoEventType,
} from '~/models'
import * as recoRepo from '../../repos/recommendationRepo'
import type { BuildEventRow, PoolItemRow } from '../../repos/recommendationRepo'
import type { AttributeAffinityInsert, ItemFeaturesInsert, VisitorProfileInsert } from '../../db/schema'
import { captureServerError } from '../observability'
import { isRecoEnabled } from '../reco'
import { invalidatePoolCache, rowToAttrs } from './pool'

const DAY = 86_400_000
const HOUR = 3_600_000
const HEAVY_PASS_INTERVAL_MS = HOUR // profiles + affinity refresh cadence (§14)

export interface BuildResult {
  skipped: boolean
  items: number
  segments: number
  profiles: number
  affinityPairs: number
  prunedEvents: number
  errors: number
}

// Listing completeness (§7.3 quality): photos / 360° / specs / description / highlighted.
const quality = (row: PoolItemRow): number => {
  const w = RECO_CONFIG.qualityWeights
  let s = 0
  if (row.images.length >= 1) s += w.photo
  if (row.images.length >= 5) s += w.manyPhotos
  if (row.images360.length >= 1) s += w.pano
  if (row.specs) s += w.specs
  if (row.description && Object.keys(row.description).length > 0) s += w.description
  if (row.priceHighlighted) s += w.highlighted
  return Math.min(1, s)
}

const minMax = (values: number[]): ((x: number) => number) => {
  const max = Math.max(0, ...values)
  const min = Math.min(0, ...values)
  const span = max - min
  return (x: number) => (span > 0 ? (x - min) / span : 0)
}

// get-or-init a Map entry without the cryptic `map.get(k) ?? map.set(k, v).get(k)!` idiom.
const getOrInit = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
  let v = map.get(key)
  if (v === undefined) {
    v = make()
    map.set(key, v)
  }
  return v
}

// item_features (popularity §9 + vector + quality) and popularity_segments (§9.3). Always runs.
const buildItemFeatures = async (
  pool: PoolItemRow[],
  events: BuildEventRow[],
  nowMs: number,
): Promise<{ items: number; segments: number; popById: Map<string, number> }> => {
  const trendSince = nowMs - RECO_CONFIG.trendWindowHours * HOUR
  const active = new Set(pool.map(p => p.id))
  const agg = new Map<string, { engagement: number; impressions: number; viewers: Set<string>; trend: number }>()
  for (const id of active) agg.set(id, { engagement: 0, impressions: 0, viewers: new Set(), trend: 0 })
  for (const e of events) {
    const a = agg.get(e.itemId)
    if (!a) continue
    const occ = e.occurredAt.getTime()
    const contrib = signalContribution(e.type as RecoEventType, e.value == null ? null : Number(e.value), occ, nowMs)
    if (e.type === 'impression') a.impressions += decayFactor(ageInDays(occ, nowMs))
    else a.engagement += contrib
    a.viewers.add(e.vid)
    if (occ >= trendSince) a.trend += contrib
  }

  const ids = [...active]
  const [bidCounts, favCounts] = await Promise.all([recoRepo.loadBidCounts(ids), recoRepo.loadFavoriteCounts(ids)])

  let sumEng = 0
  let sumImpr = 0
  for (const a of agg.values()) {
    sumEng += Math.max(0, a.engagement)
    sumImpr += a.impressions
  }
  const c0 = sumImpr > 0 ? sumEng / sumImpr : 0

  const comp = ids.map(id => {
    const a = agg.get(id)!
    const engagementSum = Math.max(0, a.engagement)
    return {
      id,
      engagementSum,
      impressions: a.impressions,
      viewers: a.viewers.size,
      trend: Math.max(0, a.trend),
      bidCount: bidCounts.get(id) ?? 0,
      favCount: favCounts.get(id) ?? 0,
      popRate: popRate(engagementSum, a.impressions, c0),
    }
  })
  const normPop = minMax(comp.map(c => c.popRate))
  const normTrend = minMax(comp.map(c => c.trend))
  const combined = comp.map(c => ({
    ...c,
    raw: popCombine({
      popRate: normPop(c.popRate),
      bidCount: c.bidCount,
      favCount: c.favCount,
      distinctViewers: c.viewers,
      trend: normTrend(c.trend),
    }),
  }))
  const normComb = minMax(combined.map(c => c.raw))

  const poolById = new Map(pool.map(p => [p.id, p]))
  const featRows: ItemFeaturesInsert[] = combined.map(c => {
    const row = poolById.get(c.id)!
    return {
      itemId: c.id,
      vector: buildItemVector(rowToAttrs(row)),
      popScore: normComb(c.raw),
      trendScore: normTrend(c.trend),
      engagementSum: c.engagementSum,
      impressionCount: c.impressions,
      distinctViewers: c.viewers,
      qualityScore: quality(row),
    }
  })
  await recoRepo.upsertItemFeaturesBatch(featRows)

  const popById = new Map(combined.map(c => [c.id, normComb(c.raw)]))
  const rankBy = (memberIds: string[]): PopularityRankingEntry[] =>
    memberIds
      .map(id => ({ itemId: id, score: popById.get(id) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, RECO_CONFIG.segmentTopN)

  await recoRepo.upsertPopularitySegment(recoRepo.GLOBAL_SEGMENT, rankBy(ids))
  let segments = 1
  const byCat = new Map<string, string[]>()
  const byCountry = new Map<string, string[]>()
  for (const p of pool) {
    getOrInit(byCat, p.categoryId, () => []).push(p.id)
    if (p.countryCode) getOrInit(byCountry, p.countryCode.toLowerCase(), () => []).push(p.id)
  }
  for (const [cat, memberIds] of byCat) {
    await recoRepo.upsertPopularitySegment(recoRepo.popularitySegmentKey('cat', cat), rankBy(memberIds))
    segments++
  }
  for (const [cc, memberIds] of byCountry) {
    await recoRepo.upsertPopularitySegment(recoRepo.popularitySegmentKey('country', cc), rankBy(memberIds))
    segments++
  }

  return { items: featRows.length, segments, popById }
}

// Engagement grouped by profile key: a logged-in user's events + their favorites/bids/offers
// fold under 'u:'+userId (merge-on-login, §4.6); anonymous events stay under the vid cookie.
const groupEngagement = (
  events: BuildEventRow[],
  derived: EngagementEvent[],
  deriveKeys: string[],
): { byKey: Map<string, EngagementEvent[]>; lastEventAt: Map<string, number> } => {
  const byKey = new Map<string, EngagementEvent[]>()
  const lastEventAt = new Map<string, number>()
  const push = (key: string, ev: EngagementEvent): void => {
    getOrInit(byKey, key, () => []).push(ev)
    lastEventAt.set(key, Math.max(lastEventAt.get(key) ?? 0, ev.occurredAt))
  }
  for (const e of events) {
    const key = e.userId ? `u:${e.userId}` : e.vid
    push(key, {
      itemId: e.itemId,
      type: e.type as RecoEventType,
      value: e.value == null ? null : Number(e.value),
      occurredAt: e.occurredAt.getTime(),
      sessionId: e.sessionId,
    })
  }
  derived.forEach((ev, i) => push(deriveKeys[i]!, ev))
  return { byKey, lastEventAt }
}

// Cosine between attribute-value columns of the visitor×value engagement matrix (§11).
const affinityRowsFor = (matrix: Map<string, Map<string, number>>, dim: string): AttributeAffinityInsert[] => {
  const values = [...matrix.keys()]
  const norms = new Map<string, number>()
  for (const v of values) {
    let n = 0
    for (const x of matrix.get(v)!.values()) n += x * x
    norms.set(v, Math.sqrt(n))
  }
  const rows: AttributeAffinityInsert[] = []
  for (const a of values) {
    const va = matrix.get(a)!
    const na = norms.get(a)!
    if (na === 0) continue
    const neighbors: Array<{ b: string; score: number }> = []
    for (const b of values) {
      if (b === a) continue
      const nb = norms.get(b)!
      if (nb === 0) continue
      let dot = 0
      for (const [key, av] of va) dot += av * (matrix.get(b)!.get(key) ?? 0)
      const score = dot / (na * nb)
      if (score > 0) neighbors.push({ b, score })
    }
    neighbors.sort((x, y) => y.score - x.score)
    for (const { b, score } of neighbors.slice(0, RECO_CONFIG.attrAffinityTopK)) {
      rows.push({ dimension: dim, valueA: a, valueB: b, score })
    }
  }
  return rows
}

// visitor_profiles (§6) + attribute_affinity (§11). Gated hourly off the precompute freshness.
const buildProfilesAndAffinity = async (
  events: BuildEventRow[],
  nowMs: number,
): Promise<{ profiles: number; affinityPairs: number }> => {
  const windowSince = nowMs - RECO_CONFIG.eventTtlDays * DAY
  const [favorites, bids, contacts] = await Promise.all([
    recoRepo.listFavoriteSignals(),
    recoRepo.listBidSignals(windowSince),
    recoRepo.listContactSignals(windowSince),
  ])
  const derived: EngagementEvent[] = []
  const deriveKeys: string[] = []
  const addDerived = (userId: string, ev: EngagementEvent): void => {
    derived.push(ev)
    deriveKeys.push(`u:${userId}`)
  }
  for (const f of favorites) addDerived(f.userId, { itemId: f.itemId, type: 'favorite_add', occurredAt: nowMs })
  for (const b of bids) addDerived(b.userId, { itemId: b.itemId, type: 'bid_placed', occurredAt: b.date.getTime() })
  for (const c of contacts)
    addDerived(c.userId, {
      itemId: c.itemId,
      type: c.kind === 'offer' ? 'offer_made' : 'contact_seller',
      occurredAt: c.created.getTime(),
    })

  const { byKey, lastEventAt } = groupEngagement(events, derived, deriveKeys)
  const refIds = new Set<string>()
  for (const list of byKey.values()) for (const ev of list) refIds.add(ev.itemId)
  const attrsMap = await recoRepo.loadItemAttrs([...refIds])

  const matrices = new Map<string, Map<string, Map<string, number>>>()
  for (const { dim } of AFFINITY_DIMS) matrices.set(dim, new Map())
  const profiles: VisitorProfileInsert[] = []

  for (const [key, evs] of byKey) {
    const engaged = aggregateEngagement(evs, nowMs)
    const engagedItems: EngagedItem[] = engaged.flatMap(({ itemId, e }) => {
      const row = attrsMap.get(itemId)
      return row && e > 0 ? [{ e, attrs: rowToAttrs(row) }] : []
    })
    if (engagedItems.length === 0) continue
    const features = buildVisitorProfile(engagedItems)
    const last = lastEventAt.get(key)
    const nEff = effectiveEvidence(engaged)
    profiles.push({
      vid: key,
      userId: key.startsWith('u:') ? key.slice(2) : null,
      features,
      topMakes: topMakes(features),
      nEff,
      alpha: confidence(nEff),
      lastEventAt: last ? new Date(last) : null,
    })
    for (const { e, attrs } of engagedItems) {
      for (const { dim, of } of AFFINITY_DIMS) {
        const value = of(attrs)
        if (!value) continue
        const col = matrices.get(dim)!
        const vec = getOrInit(col, value, () => new Map<string, number>())
        vec.set(key, (vec.get(key) ?? 0) + e)
      }
    }
  }

  await recoRepo.upsertVisitorProfilesBatch(profiles)
  let affinityPairs = 0
  for (const { dim } of AFFINITY_DIMS) {
    const rows = affinityRowsFor(matrices.get(dim)!, dim)
    await recoRepo.replaceAttributeAffinity(dim, rows)
    affinityPairs += rows.length
  }
  return { profiles: profiles.length, affinityPairs }
}

// Cron business fn (mirrors processFioPayments): idempotent, crash-safe by WINDOW (no pointer),
// per-step isolated. item_features/segments every run; the heavy pass self-gates hourly.
export const buildRecommendations = async (): Promise<BuildResult> => {
  const result: BuildResult = {
    skipped: false,
    items: 0,
    segments: 0,
    profiles: 0,
    affinityPairs: 0,
    prunedEvents: 0,
    errors: 0,
  }
  if (!isRecoEnabled()) return { ...result, skipped: true }

  const nowMs = Date.now()
  const ttlSince = nowMs - RECO_CONFIG.eventTtlDays * DAY // full retention horizon (prune + profiles)
  const featuresSince = nowMs - RECO_CONFIG.featuresWindowDays * DAY // short window for the every-run pass

  // Every-run features pass reads only the short window. The full 365-day read happens at most once
  // per heavy-pass interval (below), not on every ~10-min tick — that was the dominant build cost.
  const [pool, featureEvents] = await Promise.all([recoRepo.loadActivePool(), recoRepo.loadEventWindow(featuresSince)])

  try {
    const { items, segments } = await buildItemFeatures(pool, featureEvents, nowMs)
    result.items = items
    result.segments = segments
  } catch (e) {
    result.errors++
    captureServerError(e, { area: 'reco.build.features' })
  }

  try {
    const fresh = await recoRepo.getProfilesFreshness()
    if (!fresh || nowMs - fresh.getTime() >= HEAVY_PASS_INTERVAL_MS) {
      // The profile/affinity pass wants long-horizon taste — load the full retention window, but only
      // on the hourly heavy pass, not on every run.
      const profileEvents = await recoRepo.loadEventWindow(ttlSince)
      const { profiles, affinityPairs } = await buildProfilesAndAffinity(profileEvents, nowMs)
      result.profiles = profiles
      result.affinityPairs = affinityPairs
    }
  } catch (e) {
    result.errors++
    captureServerError(e, { area: 'reco.build.profiles' })
  }

  try {
    result.prunedEvents = await recoRepo.pruneEvents(ttlSince)
    await recoRepo.pruneStaleProfiles(ttlSince)
  } catch (e) {
    result.errors++
    captureServerError(e, { area: 'reco.build.prune' })
  }

  invalidatePoolCache()
  return result
}
