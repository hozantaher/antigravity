// Recommendation engine — single source of truth for every knob and the pure
// scoring math shared by the two surfaces (detail "Podobné inzeráty" + newsletter).
// Spec: docs/recommendation-algorithm.md. Everything here is pure and takes `nowMs`
// as a parameter (never reads the clock) so it is deterministically unit-testable
// and reusable by the no-anchor newsletter batch.
import { ItemStatus, itemCurrentPrice, type Item } from './Item'

// ── Signal taxonomy (§3) ──────────────────────────────────────────────────────
export const RECO_EVENT_TYPES = [
  'bid_placed',
  'offer_made',
  'favorite_add',
  'contact_seller',
  'share',
  'compare_add',
  'pano_360_interact',
  'photo_zoom',
  'dwell_active',
  'video_play',
  'photo_view',
  'detail_view',
  'search_query',
  'scroll_depth',
  'category_view',
  'card_hover_dwell',
  'card_viewport_dwell',
  'impression',
  'favorite_remove',
  'short_dwell_bounce',
  'impression_fatigue',
] as const

export type RecoEventType = (typeof RECO_EVENT_TYPES)[number]

export type RecoSurface = 'detail' | 'home' | 'listing' | 'newsletter'

const RECO_EVENT_TYPE_SET = new Set<string>(RECO_EVENT_TYPES)
export const isRecoEventType = (v: unknown): v is RecoEventType => typeof v === 'string' && RECO_EVENT_TYPE_SET.has(v)

const RECO_SURFACE_SET = new Set<string>(['detail', 'home', 'listing', 'newsletter'])
export const isRecoSurface = (v: unknown): v is RecoSurface => typeof v === 'string' && RECO_SURFACE_SET.has(v)

// First-party visitor cookie (set client-side after consent; read server-side; rides SSR).
export const VID_COOKIE = 'a24_vid'

// The attribute snapshot the client attaches to an event and the within-session
// re-rank reads back (§14). Best-effort — card payloads may not carry every field.
export interface TrackEventMeta {
  make?: string
  bodyType?: string
  priceBand?: string
}

// Client → POST /api/track payload (§3.6). `id` is the idempotency key.
export interface TrackEvent {
  id: string
  type: RecoEventType
  itemId?: string | null
  categoryId?: string | null
  value?: number | null
  surface?: RecoSurface | null
  position?: number | null
  propensity?: number | null
  meta?: TrackEventMeta | null
  occurredAt: number
}

// ── Configuration (§13) ───────────────────────────────────────────────────────
// Hand-tuned priors; later learned from conversions (Phase 5). Numeric dims are
// scored with a Gaussian kernel; price lives in log space (heavy right tail).
const NUMERIC_DIMS = ['price', 'year', 'enginePowerKw', 'engineDisplacementCcm'] as const
export type NumericDim = (typeof NUMERIC_DIMS)[number]

const CATEGORICAL_DIMS = [
  'categoryId',
  'type',
  'make',
  'model',
  'bodyType',
  'fuelType',
  'transmission',
  'driveType',
  'color',
  'countryCode',
] as const
export type CategoricalDim = (typeof CATEGORICAL_DIMS)[number]

export const RECO_CONFIG = {
  // Base intent weight per signal (§3.1). Negative = rejection.
  signalWeights: {
    bid_placed: 10,
    offer_made: 7,
    favorite_add: 6,
    contact_seller: 4.5,
    share: 5,
    compare_add: 3,
    pano_360_interact: 3,
    photo_zoom: 2.5,
    dwell_active: 2.5,
    video_play: 2,
    photo_view: 2,
    detail_view: 1.5,
    search_query: 1,
    scroll_depth: 1,
    category_view: 0.6,
    card_hover_dwell: 0.5,
    card_viewport_dwell: 0.5,
    impression: 0,
    favorite_remove: -2,
    short_dwell_bounce: -0.5,
    impression_fatigue: -0.3,
  } as Record<RecoEventType, number>,
  // sat(x, x0) scale per saturating signal (§3.1).
  saturation: {
    photo_view: 8,
    dwell_active: 90,
    card_hover_dwell: 5000,
    card_viewport_dwell: 6,
    pano_360_interact: 3,
    photo_zoom: 3,
    impression_fatigue: 10,
  } as Record<string, number>,
  dwellClampSec: 180,
  hoverThresholdMs: 800,
  viewportDwellThresholdSec: 2,
  returnMultStrength: 0.3, // ReturnMult = 1 + strength·sat(returnVisits, sat)
  returnMultSat: 3,
  halfLifeDays: 21, // H — profile time decay (§5)
  confidenceK: 5, // K — α smoothing (§6.3)
  popPriorM: 20, // m — Bayes shrink of engagement rate (§9.1)
  anchorBeta: 0.65, // β — anchor weight on detail (§7.2)
  // ω_d — dimension importance (§7.1). Dims absent here default to 0.
  dimensionWeights: {
    categoryId: 1.0,
    make: 0.9,
    bodyType: 0.7,
    price: 0.7,
    year: 0.6,
    model: 0.5,
    fuelType: 0.5,
    transmission: 0.4,
    driveType: 0.4,
    enginePowerKw: 0.4,
    engineDisplacementCcm: 0.3,
    countryCode: 0.3,
    type: 0.3,
    color: 0.2,
  } as Record<string, number>,
  // ψ_d — cross-attribute affinity weight (§11).
  psiWeights: { make: 1.0, bodyType: 0.6, priceBand: 0.6, category: 0.5 } as Record<string, number>,
  explorationEpsilon: 0.15, // ε (§10.5)
  mmrLambda: 0.7, // λ — relevance vs diversity (§10.4)
  withinSessionBoost: 0.25, // δ — client within-session re-rank (§14)
  attrAffinityTopK: 20,
  perBrandCap: 2,
  perCategoryCap: 3,
  // final(v,c) component weights (§7.3).
  finalWeights: { rel: 1.0, trend: 0.15, quality: 0.1, fresh: 0.15 },
  freshOnSiteWindowHours: 24, // "ending soon" boost window on-site (§8)
  freshOnSiteMaxBoost: 0.3,
  newsletterHorizonHours: 48, // skip auctions ending sooner than this after send (§8/§12)
  newsletterDueDays: 7, // per-user cadence — weekly (cron runs every 2 days)
  eventTtlDays: 365, // raw-event retention; the long-horizon profile/affinity pass reads this far back
  // The every-run item_features pass (popularity/trend) only needs recent signal: engagement decays
  // with halfLifeDays=21, so events past ~6 half-lives contribute <2% and don't move rankings. Loading
  // the full 365-day window every ~10 min was the dominant build cost — read this short window instead.
  featuresWindowDays: 120,
  sigmaFloor: 0.5, // σ floor for numeric dims (§6.2)
  topMakesK: 12,
  // popularity component blend (§9.2); caller min-max normalizes inputs.
  popCombineWeights: { popRate: 1.0, bids: 0.6, favs: 0.5, viewers: 0.4, trend: 0.5 },
  // §9 popularity-pass knobs (build cron): trend accumulation window + segment ranking depth.
  trendWindowHours: 72,
  segmentTopN: 60,
  // Listing-completeness quality weights (§7.3): photo / 5+ photos / 360° / specs / desc / highlighted.
  qualityWeights: { photo: 0.35, manyPhotos: 0.15, pano: 0.15, specs: 0.2, description: 0.1, highlighted: 0.05 },
  // CZK price-band thresholds (upper bounds, ascending). Used for affinity + meta.
  priceBands: [100_000, 300_000, 600_000, 1_000_000, 2_000_000],
  servingDefaultN: 12,
  servingMaxN: 24,
  // Only these statuses are recommendable (§8 hard gate).
  validStatuses: [ItemStatus.AuctionLive, ItemStatus.AuctionSoon, ItemStatus.BuyNow] as readonly ItemStatus[],
}

export const numericDims = (): readonly NumericDim[] => NUMERIC_DIMS
export const categoricalDims = (): readonly CategoricalDim[] => CATEGORICAL_DIMS

const dimWeight = (dim: string): number => RECO_CONFIG.dimensionWeights[dim] ?? 0
const signalWeight = (type: RecoEventType): number => RECO_CONFIG.signalWeights[type] ?? 0

// ── Transformations (§3.1, §5) ────────────────────────────────────────────────
/** Saturating transform sat(x, x0) = 1 − exp(−x / x0), output 0…1. */
export const saturate = (x: number, x0: number): number => {
  if (x0 <= 0) return x > 0 ? 1 : 0
  return 1 - Math.exp(-Math.max(0, x) / x0)
}

/** Exponential time decay with half-life H (days). */
export const decayFactor = (ageDays: number, halfLifeDays = RECO_CONFIG.halfLifeDays): number =>
  Math.exp((-Math.LN2 * Math.max(0, ageDays)) / halfLifeDays)

export const ageInDays = (occurredAtMs: number, nowMs: number): number =>
  Math.max(0, (nowMs - occurredAtMs) / 86_400_000)

/** Per-signal magnitude (saturation/clamp/threshold). Sign comes from the weight. */
const satScale = (key: string): number => RECO_CONFIG.saturation[key] ?? 1

export const transformSignal = (type: RecoEventType, rawValue?: number | null): number => {
  const raw = rawValue ?? 1
  switch (type) {
    case 'dwell_active':
      return saturate(Math.min(raw, RECO_CONFIG.dwellClampSec), satScale('dwell_active'))
    case 'photo_view':
      return saturate(raw, satScale('photo_view'))
    case 'photo_zoom':
      return saturate(raw, satScale('photo_zoom'))
    case 'pano_360_interact':
      return saturate(raw, satScale('pano_360_interact'))
    case 'impression_fatigue':
      return saturate(raw, satScale('impression_fatigue'))
    case 'card_hover_dwell':
      return raw < RECO_CONFIG.hoverThresholdMs ? 0 : saturate(raw, satScale('card_hover_dwell'))
    case 'card_viewport_dwell':
      return raw < RECO_CONFIG.viewportDwellThresholdSec ? 0 : saturate(raw, satScale('card_viewport_dwell'))
    case 'scroll_depth':
      return Math.max(0, Math.min(1, raw))
    default:
      // Unit-intent signals (bid_placed, favorite_add, share, …): magnitude 1.
      return 1
  }
}

// ── Engagement E(v, i) (§5) ────────────────────────────────────────────────────
export interface EngagementEvent {
  itemId: string
  type: RecoEventType
  value?: number | null
  occurredAt: number
  sessionId?: string | null
}

export interface ItemEngagement {
  itemId: string
  /** Clamped (≥0) engagement weight for the centroid. */
  e: number
  /** Recency of the freshest contributing event — drives nEff, not ΣE (§6.3). */
  evidence: number
}

/** Single event's decayed weighted contribution: w·transform·decay (§5). */
export const signalContribution = (
  type: RecoEventType,
  value: number | null | undefined,
  occurredAtMs: number,
  nowMs: number,
): number => signalWeight(type) * transformSignal(type, value) * decayFactor(ageInDays(occurredAtMs, nowMs))

const eventScore = (e: EngagementEvent, nowMs: number): number =>
  signalContribution(e.type, e.value, e.occurredAt, nowMs)

/**
 * Collapse a visitor's events into per-item engagement (§5): Σ w·transform·decay,
 * multiplied by the return-loyalty multiplier, clamped to ≥0. `evidence` is the
 * freshest decay among contributing events — confidence counts *items*, not ΣE.
 */
export const aggregateEngagement = (events: EngagementEvent[], nowMs: number): ItemEngagement[] => {
  const sums = new Map<string, number>()
  const sessions = new Map<string, Set<string>>()
  const evidence = new Map<string, number>()
  for (const e of events) {
    if (!e.itemId) continue
    sums.set(e.itemId, (sums.get(e.itemId) ?? 0) + eventScore(e, nowMs))
    const decay = decayFactor(ageInDays(e.occurredAt, nowMs))
    evidence.set(e.itemId, Math.max(evidence.get(e.itemId) ?? 0, decay))
    if (e.type === 'detail_view' && e.sessionId) {
      const set = sessions.get(e.itemId) ?? new Set<string>()
      set.add(e.sessionId)
      sessions.set(e.itemId, set)
    }
  }
  const out: ItemEngagement[] = []
  for (const [itemId, sum] of sums) {
    const returnVisits = Math.max(0, (sessions.get(itemId)?.size ?? 1) - 1)
    const returnMult = 1 + RECO_CONFIG.returnMultStrength * saturate(returnVisits, RECO_CONFIG.returnMultSat)
    out.push({ itemId, e: Math.max(0, sum * returnMult), evidence: evidence.get(itemId) ?? 0 })
  }
  return out
}

/** Evidence = decayed count of distinct engaged items, NOT ΣE (§6.3). */
export const effectiveEvidence = (engaged: ItemEngagement[]): number =>
  engaged.reduce((acc, i) => (i.e > 0 ? acc + i.evidence : acc), 0)

/** Confidence α = nEff / (nEff + K) (§6.3). Spans 0 (cold) → 1 (heavy). */
export const confidence = (nEff: number, k = RECO_CONFIG.confidenceK): number => nEff / (nEff + k)

// ── Taste profile (§6) ─────────────────────────────────────────────────────────
export interface ItemAttrs {
  categorical: Partial<Record<CategoricalDim, string | undefined>>
  numeric: Partial<Record<NumericDim, number | undefined>>
}

export interface NumericGaussian {
  mu: number
  sigma: number
}

export interface VisitorFeatureVector {
  categorical: Record<string, Record<string, number>> // dim → value → mass (sums to 1 per dim)
  numeric: Record<string, NumericGaussian> // dim → Gaussian (price in log space)
}

export interface EngagedItem {
  e: number
  attrs: ItemAttrs
}

const numericValueForSpace = (dim: NumericDim, x: number): number => (dim === 'price' ? Math.log(Math.max(x, 1)) : x)

/**
 * Engagement-weighted centroid of engaged items in attribute space (§6):
 * categorical dims → mass distributions, numeric dims → weighted μ/σ (price log).
 */
export const buildVisitorProfile = (items: EngagedItem[]): VisitorFeatureVector => {
  const categorical: Record<string, Record<string, number>> = {}
  for (const dim of CATEGORICAL_DIMS) {
    const masses: Record<string, number> = {}
    let total = 0
    for (const { e, attrs } of items) {
      const v = attrs.categorical[dim]
      if (v == null || e <= 0) continue
      masses[v] = (masses[v] ?? 0) + e
      total += e
    }
    if (total > 0) {
      for (const k of Object.keys(masses)) masses[k] = masses[k]! / total
      categorical[dim] = masses
    }
  }

  const numeric: Record<string, NumericGaussian> = {}
  for (const dim of NUMERIC_DIMS) {
    let wSum = 0
    let mean = 0
    for (const { e, attrs } of items) {
      const x = attrs.numeric[dim]
      if (x == null || e <= 0) continue
      wSum += e
      mean += e * numericValueForSpace(dim, x)
    }
    if (wSum <= 0) continue
    mean /= wSum
    let varSum = 0
    for (const { e, attrs } of items) {
      const x = attrs.numeric[dim]
      if (x == null || e <= 0) continue
      const z = numericValueForSpace(dim, x)
      varSum += e * (z - mean) * (z - mean)
    }
    const sigma = Math.max(Math.sqrt(varSum / wSum), RECO_CONFIG.sigmaFloor)
    numeric[dim] = { mu: mean, sigma }
  }

  return { categorical, numeric }
}

/** Top-K makes by engagement mass (high-cardinality dim kept separately, §6.1). */
export const topMakes = (profile: VisitorFeatureVector, k = RECO_CONFIG.topMakesK): Array<[string, number]> =>
  Object.entries(profile.categorical.make ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)

// ── Relevance: personal ⊕ popularity ⊕ anchor (§7) ────────────────────────────
export const categoricalSim = (profile: VisitorFeatureVector, dim: string, value: string): number =>
  profile.categorical[dim]?.[value] ?? 0

export const numericSim = (profile: VisitorFeatureVector, dim: NumericDim, x: number): number | undefined => {
  const g = profile.numeric[dim]
  if (!g) return undefined
  const z = (numericValueForSpace(dim, x) - g.mu) / g.sigma
  return Math.exp(-0.5 * z * z)
}

/** personal(v, c) — ω-weighted mean over dims, skipping & renormalizing absentees (§7.1). */
export const personal = (profile: VisitorFeatureVector, cand: ItemAttrs): number => {
  let num = 0
  let den = 0
  for (const dim of CATEGORICAL_DIMS) {
    const value = cand.categorical[dim]
    if (value == null || !profile.categorical[dim]) continue
    const w = dimWeight(dim)
    if (w <= 0) continue
    num += w * categoricalSim(profile, dim, value)
    den += w
  }
  for (const dim of NUMERIC_DIMS) {
    const x = cand.numeric[dim]
    if (x == null) continue
    const sim = numericSim(profile, dim, x)
    if (sim == null) continue
    const w = dimWeight(dim)
    if (w <= 0) continue
    num += w * sim
    den += w
  }
  return den > 0 ? num / den : 0
}

/** base(v, c) = α·personal + (1−α)·pop_seg — graceful degradation in one line (§7.1). */
export const base = (alpha: number, personalScore: number, popSeg: number): number =>
  alpha * personalScore + (1 - alpha) * popSeg

// Sparse content vector for the anchor cosine (§7.2). One-hot categoricals +
// discretized numerics, each weighted by its dimension importance.
export type ItemVector = Record<string, number>

const bandIndex = (value: number, thresholds: number[]): number => {
  for (let i = 0; i < thresholds.length; i++) if (value <= thresholds[i]!) return i
  return thresholds.length
}

export const priceBand = (amount?: number | null): string | undefined =>
  amount == null ? undefined : `b${bandIndex(amount, RECO_CONFIG.priceBands)}`

const yearBand = (year: number): string => `y${Math.floor(year / 3) * 3}`

export const buildItemVector = (attrs: ItemAttrs): ItemVector => {
  const vec: ItemVector = {}
  for (const dim of CATEGORICAL_DIMS) {
    const v = attrs.categorical[dim]
    const w = dimWeight(dim)
    if (v == null || w <= 0) continue
    vec[`${dim}:${v}`] = Math.sqrt(w)
  }
  const pb = priceBand(attrs.numeric.price)
  if (pb) vec[`priceBand:${pb}`] = Math.sqrt(dimWeight('price'))
  const year = attrs.numeric.year
  if (year != null) vec[`yearBand:${yearBand(year)}`] = Math.sqrt(dimWeight('year'))
  return vec
}

/** Cosine similarity over sparse content vectors (§7.2). */
export const cosineSim = (a: ItemVector, b: ItemVector): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (const k in a) {
    const av = a[k]!
    na += av * av
    const bv = b[k]
    if (bv !== undefined) dot += av * bv
  }
  for (const k in b) {
    const bv = b[k]!
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Cross-attribute affinity (§11). lookup(dimension, valueA, valueB) → learned cosine.
export type AffinityLookup = (dimension: string, valueA: string, valueB: string) => number

export const AFFINITY_DIMS: Array<{ dim: string; of: (a: ItemAttrs) => string | undefined }> = [
  { dim: 'make', of: a => a.categorical.make },
  { dim: 'bodyType', of: a => a.categorical.bodyType },
  { dim: 'priceBand', of: a => priceBand(a.numeric.price) },
  { dim: 'category', of: a => a.categorical.categoryId },
]

export const attrAffinity = (anchor: ItemAttrs, cand: ItemAttrs, lookup: AffinityLookup): number => {
  let num = 0
  let den = 0
  for (const { dim, of } of AFFINITY_DIMS) {
    const a = of(anchor)
    const c = of(cand)
    if (a == null || c == null) continue
    const psi = RECO_CONFIG.psiWeights[dim] ?? 0
    if (psi <= 0) continue
    num += psi * lookup(dim, a, c)
    den += psi
  }
  return den > 0 ? num / den : 0
}

/** γ — confidence-weighted: lean on content until affinity data exists (§7.2). */
export const gammaFor = (hasAffinityData: boolean): number => (hasAffinityData ? 0.6 : 1)

export const anchorSim = (gamma: number, contentSim: number, affinity: number): number =>
  gamma * contentSim + (1 - gamma) * affinity

/** rel(v, c | a): anchor present → β·sim(a,c) + (1−β)·base; absent → base (§7.2). */
export const relevance = (anchorSimScore: number | null, baseScore: number): number =>
  anchorSimScore == null
    ? baseScore
    : RECO_CONFIG.anchorBeta * anchorSimScore + (1 - RECO_CONFIG.anchorBeta) * baseScore

// ── Freshness & validity (§8) ──────────────────────────────────────────────────
/** On-site: mild urgency boost for auctions ending within the window (§8). */
export const freshOnSite = (endMs: number | null | undefined, nowMs: number): number => {
  if (endMs == null) return 0
  const hoursLeft = (endMs - nowMs) / 3_600_000
  if (hoursLeft <= 0 || hoursLeft >= RECO_CONFIG.freshOnSiteWindowHours) return 0
  return RECO_CONFIG.freshOnSiteMaxBoost * (1 - hoursLeft / RECO_CONFIG.freshOnSiteWindowHours)
}

/** Newsletter: exclude auctions ending before the read horizon (§8/§12). Ads (no end) pass. */
export const passesNewsletterHorizon = (endMs: number | null | undefined, sendAtMs: number): boolean =>
  endMs == null || endMs >= sendAtMs + RECO_CONFIG.newsletterHorizonHours * 3_600_000

/** Hard validity gate (§8): not the anchor, not converted, status recommendable. */
export const validStatusGate = (
  status: ItemStatus,
  candidateId: string,
  anchorId: string | null,
  excluded: ReadonlySet<string>,
): boolean => candidateId !== anchorId && !excluded.has(candidateId) && RECO_CONFIG.validStatuses.includes(status)

export interface FinalScoreParts {
  relevance: number
  trend: number
  quality: number
  fresh: number
}

/** final(v, c) — weighted blend × hard validity gate (§7.3). */
export const finalScore = (parts: FinalScoreParts, valid: boolean): number => {
  if (!valid) return 0
  const w = RECO_CONFIG.finalWeights
  return w.rel * parts.relevance + w.trend * parts.trend + w.quality * parts.quality + w.fresh * parts.fresh
}

// ── Diversity & exploration (§10.4, §10.5) ─────────────────────────────────────
export interface RankCandidate {
  id: string
  score: number
  vector: ItemVector
  make?: string
  categoryId?: string
}

/** Maximal Marginal Relevance with per-brand/per-category caps (§10.4). */
export const mmrSelect = (candidates: RankCandidate[], n: number): RankCandidate[] => {
  const lambda = RECO_CONFIG.mmrLambda
  const pool = [...candidates].sort((a, b) => b.score - a.score)
  const selected: RankCandidate[] = []
  const brandCount = new Map<string, number>()
  const catCount = new Map<string, number>()
  while (selected.length < n && pool.length > 0) {
    let bestIdx = -1
    let bestVal = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!
      if (c.make && (brandCount.get(c.make) ?? 0) >= RECO_CONFIG.perBrandCap) continue
      if (c.categoryId && (catCount.get(c.categoryId) ?? 0) >= RECO_CONFIG.perCategoryCap) continue
      let maxSim = 0
      for (const s of selected) maxSim = Math.max(maxSim, cosineSim(c.vector, s.vector))
      const val = lambda * c.score - (1 - lambda) * maxSim
      if (val > bestVal) {
        bestVal = val
        bestIdx = i
      }
    }
    if (bestIdx < 0) break // every remaining candidate hits a cap
    const picked = pool.splice(bestIdx, 1)[0]!
    selected.push(picked)
    if (picked.make) brandCount.set(picked.make, (brandCount.get(picked.make) ?? 0) + 1)
    if (picked.categoryId) catCount.set(picked.categoryId, (catCount.get(picked.categoryId) ?? 0) + 1)
  }
  return selected
}

/** FNV-1a → unit float [0,1). Stable per visitor → reproducible exploration. */
export const hashUnit = (str: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}

/**
 * Reserve ~ε of the tail for popular-but-unseen / fresh items (§10.5). Deterministic
 * by hash(vid) so a visitor's slots are stable across requests. `pool` is ranked
 * exploration candidates (already validity-gated, excluding `ranked`).
 */
export const epsilonInject = <T extends { id: string }>(ranked: T[], pool: T[], n: number, vid: string): T[] => {
  const slots = Math.min(Math.round(n * RECO_CONFIG.explorationEpsilon), pool.length)
  if (slots <= 0) return ranked.slice(0, n)
  const keep = ranked.slice(0, Math.max(0, n - slots))
  const have = new Set(keep.map(r => r.id))
  const fresh = pool.filter(p => !have.has(p.id))
  const offset = Math.floor(hashUnit(vid) * Math.max(1, fresh.length))
  const picks: T[] = []
  for (let i = 0; i < fresh.length && picks.length < slots; i++) {
    const pick = fresh[(offset + i) % fresh.length]
    if (pick) picks.push(pick)
  }
  return [...keep, ...picks].slice(0, n)
}

// ── Popularity = "průměr" (§9) ──────────────────────────────────────────────────
/** Bayesian-shrunk engagement rate toward the population mean C₀ (§9.1). */
export const popRate = (engagementSum: number, impressionCount: number, c0: number): number =>
  (engagementSum + RECO_CONFIG.popPriorM * c0) / (impressionCount + RECO_CONFIG.popPriorM)

export interface PopComponents {
  popRate: number
  bidCount: number
  favCount: number
  distinctViewers: number
  trend: number
}

/** Precomputed top-N ranking entry stored per popularity segment (§9.3). */
export interface PopularityRankingEntry {
  itemId: string
  score: number
}

/** Display-ready recommended vehicle for the newsletter e-mail (§12). */
export interface EmailItemCard {
  title: string
  price?: string
  endsAt?: string
  imageUrl: string
  url: string
}

/** Combine popularity components (caller passes already min-max normalized inputs, §9.2). */
export const popCombine = (p: PopComponents): number => {
  const w = RECO_CONFIG.popCombineWeights
  return (
    w.popRate * p.popRate +
    w.bids * Math.log1p(p.bidCount) +
    w.favs * Math.log1p(p.favCount) +
    w.viewers * Math.log1p(p.distinctViewers) +
    w.trend * p.trend
  )
}

// ── Within-session client re-rank (§14) ────────────────────────────────────────
export interface SessionSeen {
  makes: Set<string>
  bodyTypes: Set<string>
  priceBands: Set<string>
}

export interface ReRankAttrs {
  make?: string
  bodyType?: string
  priceBand?: string
}

/**
 * Light reorder of the server ranking by what the visitor is browsing *right now*
 * (§14). Boosts candidates whose attrs match the session; stable, never drops.
 */
export const withinSessionReRank = <T>(
  items: T[],
  attrsOf: (item: T) => ReRankAttrs,
  seen: SessionSeen,
  delta = RECO_CONFIG.withinSessionBoost,
): T[] => {
  const n = items.length
  return items
    .map((item, index) => {
      const a = attrsOf(item)
      let present = 0
      let matched = 0
      if (a.make != null) {
        present++
        if (seen.makes.has(a.make)) matched++
      }
      if (a.bodyType != null) {
        present++
        if (seen.bodyTypes.has(a.bodyType)) matched++
      }
      if (a.priceBand != null) {
        present++
        if (seen.priceBands.has(a.priceBand)) matched++
      }
      const attrMatch = present > 0 ? matched / present : 0
      return { item, index, score: (n - index) * (1 + delta * attrMatch) }
    })
    .sort((x, y) => y.score - x.score || x.index - y.index) // stable on ties
    .map(x => x.item)
}

// ── Newsletter cadence (§12) ────────────────────────────────────────────────────
/** Due if never sent or the cadence window has elapsed (§12). */
export const isNewsletterDue = (lastSentAtMs: number | null | undefined, nowMs: number): boolean =>
  lastSentAtMs == null || nowMs - lastSentAtMs >= RECO_CONFIG.newsletterDueDays * 86_400_000

// ── Client helper: attribute snapshot for tracking + re-rank ───────────────────
/** Best-effort {make, bodyType, priceBand} snapshot for an item (§3.1 meta). */
export const itemSignalMeta = (item: Item): TrackEventMeta => ({
  make: item.specs?.manufacturer,
  bodyType: item.bodyType,
  priceBand: priceBand(itemCurrentPrice(item)?.amount),
})
