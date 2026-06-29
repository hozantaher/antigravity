import type { ItemType } from './Item'
import type { BodyType, DriveType, FuelType, Transmission, VehicleColor } from './VehicleSpecs'
import { BODY_TYPES, DRIVE_TYPES, FUEL_TYPES, TRANSMISSIONS, VEHICLE_COLORS } from './VehicleSpecs'

// Pure, serializable search query: the free-text term `q` plus the structured facets that map to
// existing `items` columns. No IO — parse/serialize/normalize only. Kept in models/ (not a
// composable) so a future saved-search domain can persist and re-run it through the same repo
// contract. Escaping/SQL is the repo's job; this layer only coerces and elides.

export type SearchItemType = ItemType | 'auction' | 'ad'

export interface SearchQuery {
  q?: string
  type?: SearchItemType
  categoryId?: string
  priceMin?: number
  priceMax?: number
  fuelType?: FuelType
  bodyType?: BodyType
  transmission?: Transmission
  driveType?: DriveType
  color?: VehicleColor
  yearFrom?: number
  yearTo?: number
}

// Sort options the search UI offers. Tuple so it doubles as a runtime list and a type. The
// default ('relevance') means "the shared listing order" (status rank + tie-breaks) — no extra
// param is sent for it, matching how listings already sort.
export const SEARCH_SORTS = ['relevance', 'newest', 'priceAsc', 'priceDesc'] as const
export type SearchSort = (typeof SEARCH_SORTS)[number]

export const DEFAULT_SEARCH_SORT: SearchSort = 'relevance'

const SEARCH_SORT_SET: ReadonlySet<string> = new Set(SEARCH_SORTS)

// Coerce an untrusted ?sort value to a known SearchSort, defaulting to 'relevance'. Unknown/blank
// input falls back to the default rather than 400-ing — matching the lenient facet parse. Kept OUT
// of SearchQuery on purpose: sort is presentation (the order), not a facet (what matches), so it
// never enters the saved-search shape or the parse∘serialize identity of SearchQuery.
export const parseSearchSort = (v: unknown): SearchSort => {
  const first = Array.isArray(v) ? v[0] : v
  const s = first == null ? '' : String(first).trim()
  return SEARCH_SORT_SET.has(s) ? (s as SearchSort) : DEFAULT_SEARCH_SORT
}

// True for the default order ('relevance'). The UI/composable elide a default sort from the query
// record + URL so a sort-free search paginates exactly like the listings (no extra ?sort=).
export const isDefaultSearchSort = (sort: SearchSort): boolean => sort === DEFAULT_SEARCH_SORT

// The string keys SearchQuery serializes to in the URL / query record (1:1 with the field names).
const STRING_FACETS = ['type', 'categoryId', 'fuelType', 'bodyType', 'transmission', 'driveType', 'color'] as const
const NUMBER_FACETS = ['priceMin', 'priceMax', 'yearFrom', 'yearTo'] as const

const ENUM_VALUES: Record<string, ReadonlySet<string>> = {
  type: new Set(['auction', 'ad']),
  fuelType: new Set(FUEL_TYPES),
  bodyType: new Set(BODY_TYPES),
  transmission: new Set(TRANSMISSIONS),
  driveType: new Set(DRIVE_TYPES),
  color: new Set(VEHICLE_COLORS),
}

const firstValue = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)

const asTrimmedString = (v: unknown): string | undefined => {
  const first = firstValue(v)
  if (first == null) return undefined
  const s = String(first).trim()
  return s.length ? s : undefined
}

// Coerce to a finite, non-negative number; reject NaN/Infinity/negative so a junk ?priceMin=abc
// or a negative bound is dropped (ignored) rather than poisoning the WHERE clause.
const asNonNegativeNumber = (v: unknown): number | undefined => {
  const s = asTrimmedString(v)
  if (s === undefined) return undefined
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

// Parse an untrusted query record (URL query / getQuery(event)) into a clean SearchQuery. Unknown
// enum values and empty/blank/junk numbers are dropped (lenient, matching items.get) so a bad
// facet is simply ignored, never a 400. Inverted year bounds are normalized.
export const parseSearchQuery = (record: Record<string, unknown> | null | undefined): SearchQuery => {
  const src = record ?? {}
  const out: SearchQuery = {}

  const q = asTrimmedString(src.q)
  if (q !== undefined) out.q = q

  for (const key of STRING_FACETS) {
    const value = asTrimmedString(src[key])
    if (value === undefined) continue
    const allowed = ENUM_VALUES[key]
    if (allowed && !allowed.has(value)) continue
    ;(out as Record<string, unknown>)[key] = value
  }

  for (const key of NUMBER_FACETS) {
    const value = asNonNegativeNumber(src[key])
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }

  return normalizeYearRange(out)
}

// Swap inverted year bounds (yearFrom > yearTo) so the range is always well-formed. Returns a new
// object (immutable) — only the year fields are touched. Same idea could apply to price, but the
// spec scopes the swap to year; price bounds pass through.
export const normalizeYearRange = (query: SearchQuery): SearchQuery => {
  const { yearFrom, yearTo } = query
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    return { ...query, yearFrom: yearTo, yearTo: yearFrom }
  }
  return query
}

// Serialize a SearchQuery to a flat string record for the URL / usePagedItems query. Empty/absent
// fields are elided (omitted) so they don't appear as `?priceMin=` — matching usePagedItems'
// filter elision. Numbers become strings; the round-trip parseSearchQuery∘searchQueryToRecord is
// the identity for any valid SearchQuery.
export const searchQueryToRecord = (query: SearchQuery): Record<string, string> => {
  const out: Record<string, string> = {}
  if (query.q) out.q = query.q
  for (const key of STRING_FACETS) {
    const value = query[key as keyof SearchQuery]
    if (value !== undefined && value !== null && value !== '') out[key] = String(value)
  }
  for (const key of NUMBER_FACETS) {
    const value = query[key]
    if (value !== undefined) out[key] = String(value)
  }
  return out
}

// True when the query carries no term and no facet — used to decide whether to render the
// "results for X" header vs the empty/browse state, and to short-circuit work.
export const isEmptySearch = (query: SearchQuery): boolean => Object.keys(searchQueryToRecord(query)).length === 0
