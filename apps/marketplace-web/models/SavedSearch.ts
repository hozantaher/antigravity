import type { SearchQuery } from './SearchQuery'
import { parseSearchQuery, searchQueryToRecord } from './SearchQuery'

// A user-saved search: a named, persisted SearchQuery the user can re-run and opt into email
// alerts for. The `query` field IS a SearchQuery (the same shape /api/search executes) — stored
// verbatim so the alert cron replays it through the existing itemRepo filter pipeline. Pagination
// is never stored. `lastAlertedAt` is server-only (the CAS column) and intentionally NOT on this
// model — parity with users.newsletterLastSentAt. No IO here: pure normalize/coerce only.
export interface SavedSearch {
  id: string
  userId: string
  name: string
  query: SearchQuery
  alertEnabled: boolean
  createdAt: number
  updatedAt?: number
}

// Per-user cap so a single account can't accumulate unbounded saved searches (each one is a cron
// query). The create endpoint enforces it; the UI hides the save action once reached.
export const SAVED_SEARCH_MAX_PER_USER = 50

// A saved-search alert is due weekly-per-search. The cron may run more often (e.g. daily); the
// per-search due gate staggers sends naturally — same constant story as the newsletter's 7-day gate.
export const ALERT_DUE_DAYS = 7

// Cap on items in one alert digest (the newest matches). Keeps the email short and the per-search
// query cheap — mirrors the newsletter's NEWSLETTER_LIMIT.
export const ALERT_ITEM_CAP = 8

// Max length of a user-chosen saved-search name (storage / abuse bound).
export const SAVED_SEARCH_NAME_MAX = 120

// Normalize an untrusted stored/incoming query to a clean SearchQuery: drops empty/blank/unknown
// facets and junk numbers via the SearchQuery parser, so a malformed `query` jsonb can never poison
// the alert WHERE clause. Round-trips through the record form (parse∘serialize) = the SearchQuery
// identity for any valid query. Returns a new object (immutable).
export const normalizeSavedSearchQuery = (query: SearchQuery | null | undefined): SearchQuery =>
  parseSearchQuery(searchQueryToRecord(query ?? {}))

// Count of active facets/term in a saved query — powers the "{count} filters" UI summary.
export const savedSearchFilterCount = (query: SearchQuery): number => Object.keys(searchQueryToRecord(query)).length

// True when a saved-search name is acceptable (non-blank, within the length bound). Pure so the
// create endpoint and any client form can share one rule.
export const isValidSavedSearchName = (name: unknown): name is string =>
  typeof name === 'string' && name.trim().length > 0 && name.trim().length <= SAVED_SEARCH_NAME_MAX

// Cutoff (epoch-ms) before which a search's lastAlertedAt counts as "due again": now minus the
// weekly window. The repo CAS compares lastAlertedAt against this. Pure for unit testing.
export const alertDueCutoffMs = (nowMs: number): number => nowMs - ALERT_DUE_DAYS * 86_400_000

// The public item-filter subset an alert query runs as. A SavedSearch never matches hidden or sold
// listings — an alert only surfaces live, buyable items — so those two are forced here regardless of
// what the stored query holds. The remaining facets pass through from the normalized SearchQuery.
// itemRepo executes this exact shape through the same applyItemFilter the public search uses.
export interface SavedSearchItemFilter {
  sold: false
  hidden: false
  q?: string
  type?: 'auction' | 'ad'
  categoryId?: string
  priceMin?: number
  priceMax?: number
  fuelType?: string
  bodyType?: string
  transmission?: string
  driveType?: string
  color?: string
  yearFrom?: number
  yearTo?: number
}

// Map a stored SearchQuery → the alert item filter, forcing sold:false + hidden:false. Normalizes
// first so a junk stored query is sanitized. Pure (no DB) so it's unit-testable; the repo applies it.
export const savedSearchQueryToItemFilter = (query: SearchQuery | null | undefined): SavedSearchItemFilter => {
  const q = normalizeSavedSearchQuery(query)
  return {
    sold: false,
    hidden: false,
    ...(q.q !== undefined ? { q: q.q } : {}),
    ...(q.type !== undefined ? { type: q.type as 'auction' | 'ad' } : {}),
    ...(q.categoryId !== undefined ? { categoryId: q.categoryId } : {}),
    ...(q.priceMin !== undefined ? { priceMin: q.priceMin } : {}),
    ...(q.priceMax !== undefined ? { priceMax: q.priceMax } : {}),
    ...(q.fuelType !== undefined ? { fuelType: q.fuelType } : {}),
    ...(q.bodyType !== undefined ? { bodyType: q.bodyType } : {}),
    ...(q.transmission !== undefined ? { transmission: q.transmission } : {}),
    ...(q.driveType !== undefined ? { driveType: q.driveType } : {}),
    ...(q.color !== undefined ? { color: q.color } : {}),
    ...(q.yearFrom !== undefined ? { yearFrom: q.yearFrom } : {}),
    ...(q.yearTo !== undefined ? { yearTo: q.yearTo } : {}),
  }
}
