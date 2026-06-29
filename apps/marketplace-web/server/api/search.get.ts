import { parseSearchQuery, parseSearchSort } from '~/models'
import { searchPage } from '~/server/repos/itemRepo'

// Public, anonymous, SSR-rendered faceted search. Unauthenticated and potentially expensive
// (trgm scan + facets), so it is rate-limited per-IP like the other public-but-costly reads.
// Facet params are parsed leniently (unknown values dropped) into a SearchQuery; the bare `q`
// path is preserved. Response stays Paginated<Item> so the documented Algolia swap is a drop-in.
export default defineEventHandler(event => {
  enforceRateLimit(event, { bucket: 'search', limit: 60, windowMs: 60_000 })
  const raw = getQuery(event)
  const query = parseSearchQuery(raw)
  // A 1–2 char q can't use the pg_trgm GIN indexes (a trigram needs ≥3 chars) and would force a
  // full seq-scan with per-row JSONB unaccent — drop the text term (facets still apply).
  const term = query.q?.trim()
  if (term && term.length < 3) query.q = undefined
  // Sort is presentation, parsed separately from the facets (unknown ?sort falls back to relevance).
  return searchPage(query, parsePageParams(event), parseSearchSort(raw.sort))
})
