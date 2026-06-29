import {
  AFFINITY_DIMS,
  anchorSim,
  attrAffinity,
  base,
  cosineSim,
  epsilonInject,
  finalScore,
  gammaFor,
  mmrSelect,
  passesNewsletterHorizon,
  personal,
  relevance,
  validStatusGate,
  freshOnSite,
  type AffinityLookup,
  type Item,
  type PopularityRankingEntry,
  type RankCandidate,
} from '~/models'
import * as itemRepo from '../../repos/itemRepo'
import * as recoRepo from '../../repos/recommendationRepo'
import type { ServingItemFeatures, ServingProfile } from '../../repos/recommendationRepo'
import { captureServerError } from '../observability'
import { isRecoEnabled } from '../reco'
import { getScorablePool, getServingFeatures, poolRowToCandidate, type ScorableCandidate } from './pool'

const normalizeRanking = (ranking: PopularityRankingEntry[]): Map<string, number> => {
  const m = new Map<string, number>()
  if (ranking.length === 0) return m
  const scores = ranking.map(r => r.score)
  const max = Math.max(...scores)
  const min = Math.min(...scores)
  const span = max - min
  for (const r of ranking) m.set(r.itemId, span > 0 ? (r.score - min) / span : 1)
  return m
}

// Most specific non-empty segment (§9.3): category → country → global.
const resolveSegment = async (
  anchorCategoryId: string | undefined,
  country: string | undefined,
): Promise<{ key: string; ranking: PopularityRankingEntry[] }> => {
  const keys = [
    anchorCategoryId ? recoRepo.popularitySegmentKey('cat', anchorCategoryId) : null,
    country ? recoRepo.popularitySegmentKey('country', country) : null,
    recoRepo.GLOBAL_SEGMENT,
  ].filter((k): k is string => k != null)
  for (const key of keys) {
    const ranking = await recoRepo.getPopularitySegment(key)
    if (ranking.length > 0) return { key, ranking }
  }
  return { key: 'global', ranking: [] }
}

const zeroAffinity: AffinityLookup = () => 0

const NULL_AFFINITY = { lookup: zeroAffinity, hasData: false }

const loadAffinityLookup = async (anchor: ScorableCandidate): Promise<{ lookup: AffinityLookup; hasData: boolean }> => {
  const pairs = AFFINITY_DIMS.flatMap(({ dim, of }) => {
    const value = of(anchor.attrs)
    return value ? [{ dimension: dim, value }] : []
  })
  const map = await recoRepo.loadAnchorAffinity(pairs)
  if (map.size === 0) return NULL_AFFINITY
  // We preloaded neighbors of the anchor's value per dimension, so lookup ignores `a`.
  return { lookup: (dimension, _a, b) => map.get(dimension)?.get(b) ?? 0, hasData: true }
}

const loadProfile = async (vid?: string, userId?: string): Promise<ServingProfile | undefined> => {
  const keys = [userId ? `u:${userId}` : null, vid ?? null].filter((k): k is string => k != null)
  for (const k of keys) {
    const p = await recoRepo.getVisitorProfile(k)
    if (p) return p
  }
  return undefined
}

interface ScoreCtx {
  anchor: ScorableCandidate | null
  profile?: ServingProfile
  alpha: number
  popSeg: Map<string, number>
  feat: Map<string, ServingItemFeatures>
  affinity: { lookup: AffinityLookup; hasData: boolean }
  excluded: ReadonlySet<string>
  nowMs: number
  newsletterSendMs?: number
}

const scoreOne = (c: ScorableCandidate, ctx: ScoreCtx): RankCandidate | null => {
  if (!validStatusGate(c.status, c.id, ctx.anchor?.id ?? null, ctx.excluded)) return null
  if (ctx.newsletterSendMs != null && !passesNewsletterHorizon(c.endMs, ctx.newsletterSendMs)) return null
  const personalScore = ctx.profile ? personal(ctx.profile.features, c.attrs) : 0
  const baseScore = base(ctx.alpha, personalScore, ctx.popSeg.get(c.id) ?? 0)
  let anchorScore: number | null = null
  if (ctx.anchor) {
    const content = cosineSim(ctx.anchor.vector, c.vector)
    const aff = attrAffinity(ctx.anchor.attrs, c.attrs, ctx.affinity.lookup)
    anchorScore = anchorSim(gammaFor(ctx.affinity.hasData), content, aff)
  }
  const f = ctx.feat.get(c.id)
  const fresh = ctx.newsletterSendMs != null ? 0 : freshOnSite(c.endMs, ctx.nowMs)
  const score = finalScore(
    { relevance: relevance(anchorScore, baseScore), trend: f?.trendScore ?? 0, quality: f?.qualityScore ?? 0, fresh },
    true,
  )
  return { id: c.id, score, vector: c.vector, make: c.make, categoryId: c.categoryId }
}

// Score → MMR → ε-exploration → id list (§10.4–10.5), shared by all three serving surfaces.
// home/newsletter pass no anchorId, so the `!== anchorId` exclusion is a no-op for them.
const rankToIds = (
  pool: ScorableCandidate[],
  ctx: ScoreCtx,
  ranking: PopularityRankingEntry[],
  limit: number,
  seed: string,
  anchorId: string | null = null,
): string[] => {
  const scored = pool.flatMap(c => {
    const s = scoreOne(c, ctx)
    return s ? [s] : []
  })
  const ranked = mmrSelect(scored, limit)
  const rankedIds = new Set(ranked.map(r => r.id))
  const exploration = ranking
    .map(r => ({ id: r.itemId }))
    .filter(p => p.id !== anchorId && !rankedIds.has(p.id) && !ctx.excluded.has(p.id))
  return epsilonInject(ranked, exploration, limit, seed).map(r => r.id)
}

// Deterministic fallback chain (§10.1): popularity → newest-active → defaultSort. Always
// returns *something*; only thrown DB errors bubble (the caller swallows those too).
const fallbackItems = async (excludeId: string | null, limit: number, country?: string): Promise<Item[]> => {
  const seg = await resolveSegment(undefined, country)
  const popIds = seg.ranking
    .map(r => r.itemId)
    .filter(id => id !== excludeId)
    .slice(0, limit)
  if (popIds.length > 0) {
    const items = await itemRepo.loadCardsByIds(popIds)
    if (items.length > 0) return items
  }
  const pool = await getScorablePool(Date.now())
  const newestIds = [...pool]
    .filter(c => c.id !== excludeId)
    .sort((a, b) => (a.endMs ?? Number.MAX_SAFE_INTEGER) - (b.endMs ?? Number.MAX_SAFE_INTEGER))
    .slice(0, limit)
    .map(c => c.id)
  if (newestIds.length > 0) {
    const items = await itemRepo.loadCardsByIds(newestIds)
    if (items.length > 0) return items
  }
  const page = await itemRepo.listItemsPage({}, { page: 1, pageSize: limit, limit, offset: 0 })
  return page.items.filter(i => i.id !== excludeId).slice(0, limit)
}

const safeFallback = (excludeId: string | null, limit: number, country?: string): Promise<Item[]> =>
  fallbackItems(excludeId, limit, country).catch(() => [])

export interface RecommendForItemOpts {
  anchorId: string
  vid?: string
  userId?: string
  locale?: string
  country?: string
  limit: number
}

// Detail "Podobné inzeráty". Never throws to the caller — every failure degrades to the
// fallback chain. SSR is vid-personalized; the client refetches with the user token (§14).
export const recommendForItem = async (opts: RecommendForItemOpts): Promise<Item[]> => {
  if (!isRecoEnabled()) return safeFallback(opts.anchorId, opts.limit, opts.country)
  const nowMs = Date.now()
  try {
    const pool = await getScorablePool(nowMs)
    let anchor = pool.find(c => c.id === opts.anchorId) ?? null
    if (!anchor) {
      const attrRow = (await recoRepo.loadItemAttrs([opts.anchorId])).get(opts.anchorId)
      if (attrRow)
        anchor = poolRowToCandidate(
          {
            ...attrRow,
            startDate: null,
            endDate: null,
            images: [],
            images360: [],
            priceHighlighted: false,
            description: null,
          },
          nowMs,
        )
    }
    const [profile, excluded, affinity, feat, seg] = await Promise.all([
      loadProfile(opts.vid, opts.userId),
      opts.userId ? recoRepo.getConvertedItemIds(opts.userId) : Promise.resolve(new Set<string>()),
      anchor ? loadAffinityLookup(anchor) : Promise.resolve(NULL_AFFINITY),
      getServingFeatures(nowMs),
      resolveSegment(anchor?.categoryId, opts.country),
    ])
    const ctx: ScoreCtx = {
      anchor,
      profile,
      alpha: profile?.alpha ?? 0,
      popSeg: normalizeRanking(seg.ranking),
      feat,
      affinity,
      excluded,
      nowMs,
    }
    const ids = rankToIds(pool, ctx, seg.ranking, opts.limit, opts.vid ?? opts.userId ?? 'anon', opts.anchorId)
    if (ids.length === 0) return safeFallback(opts.anchorId, opts.limit, opts.country)
    const items = await itemRepo.loadCardsByIds(ids)
    return items.length > 0 ? items : safeFallback(opts.anchorId, opts.limit, opts.country)
  } catch (e) {
    captureServerError(e, { area: 'reco.serve.item', tags: { anchorId: opts.anchorId } })
    return safeFallback(opts.anchorId, opts.limit, opts.country)
  }
}

export interface RecommendForHomeOpts {
  vid?: string
  userId?: string
  locale?: string
  country?: string
  limit: number
}

// Homepage "Vybráno pro vás" rail (§2 third surface). Anchor-less (rel = base): personalized by
// vid/userId, otherwise the segment popularity average; on-site freshness boost applies. Never throws.
export const recommendForHome = async (opts: RecommendForHomeOpts): Promise<Item[]> => {
  if (!isRecoEnabled()) return safeFallback(null, opts.limit, opts.country)
  const nowMs = Date.now()
  try {
    const pool = await getScorablePool(nowMs)
    const [profile, excluded, feat, seg] = await Promise.all([
      loadProfile(opts.vid, opts.userId),
      opts.userId ? recoRepo.getConvertedItemIds(opts.userId) : Promise.resolve(new Set<string>()),
      getServingFeatures(nowMs),
      resolveSegment(undefined, opts.country),
    ])
    const ctx: ScoreCtx = {
      anchor: null,
      profile,
      alpha: profile?.alpha ?? 0,
      popSeg: normalizeRanking(seg.ranking),
      feat,
      affinity: NULL_AFFINITY,
      excluded,
      nowMs,
    }
    const ids = rankToIds(pool, ctx, seg.ranking, opts.limit, opts.vid ?? opts.userId ?? 'home')
    if (ids.length === 0) return safeFallback(null, opts.limit, opts.country)
    const items = await itemRepo.loadCardsByIds(ids)
    return items.length > 0 ? items : safeFallback(null, opts.limit, opts.country)
  } catch (e) {
    captureServerError(e, { area: 'reco.serve.home' })
    return safeFallback(null, opts.limit, opts.country)
  }
}

export interface RecommendForNewsletterOpts {
  userId: string
  locale?: string
  country?: string
  limit: number
  sendAtMs: number
}

// Newsletter selection (§12): no anchor (rel = base), the read horizon excludes auctions
// ending too soon, MMR + ε for diversity/discovery. Never throws.
export const recommendForNewsletter = async (opts: RecommendForNewsletterOpts): Promise<Item[]> => {
  if (!isRecoEnabled()) return []
  const nowMs = Date.now()
  try {
    const pool = await getScorablePool(nowMs)
    const [profile, excluded, feat, seg] = await Promise.all([
      loadProfile(undefined, opts.userId),
      recoRepo.getConvertedItemIds(opts.userId),
      getServingFeatures(nowMs),
      resolveSegment(undefined, opts.country),
    ])
    const ctx: ScoreCtx = {
      anchor: null,
      profile,
      alpha: profile?.alpha ?? 0,
      popSeg: normalizeRanking(seg.ranking),
      feat,
      affinity: NULL_AFFINITY,
      excluded,
      nowMs,
      newsletterSendMs: opts.sendAtMs,
    }
    return itemRepo.loadCardsByIds(rankToIds(pool, ctx, seg.ranking, opts.limit, `nl:${opts.userId}`))
  } catch (e) {
    captureServerError(e, { area: 'reco.serve.newsletter', tags: { userId: opts.userId } })
    return []
  }
}
