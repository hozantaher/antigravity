import type { H3Event } from 'h3'
import { listItemsPage } from '~/server/repos/itemRepo'

// Public, anonymous listing (homepage grid, category pages, live filter). The card projection has
// no per-user fields, so the response is identical for every visitor — a short shared cache collapses
// repeated loads into ~one DB read per window, which matters because the default ORDER BY is now()-
// based and can't be served by an index. The volatile bits (price, bid count, end time) are patched
// client-side from the separately cached /api/items/live overlay, so a slightly stale base ordering
// is safe. getKey covers every param that changes the result set.
const LISTING_MAX_AGE = 15

const parseListingFilter = (event: H3Event): { type?: 'auction' | 'ad'; live: boolean; categoryId?: string } => {
  const q = getQuery(event)
  return {
    type: q.type === 'auction' || q.type === 'ad' ? q.type : undefined,
    live: q.live === 'true' || q.live === '1',
    categoryId: typeof q.categoryId === 'string' && q.categoryId ? q.categoryId : undefined,
  }
}

export default defineCachedEventHandler(
  event => listItemsPage(parseListingFilter(event), parsePageParams(event)),
  {
    maxAge: LISTING_MAX_AGE,
    swr: true,
    getKey: event => {
      const { type, live, categoryId } = parseListingFilter(event)
      const { page, pageSize } = parsePageParams(event)
      return `items:${type ?? 'all'}:${live ? 'live' : 'all'}:${categoryId ?? 'all'}:${page}:${pageSize}`
    },
  },
)
