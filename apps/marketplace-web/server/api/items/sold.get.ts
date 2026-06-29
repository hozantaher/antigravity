import { listSoldPage } from '~/server/repos/itemRepo'

// Public, anonymous archive of sold lots — changes only when a lot settles (rare relative to reads),
// so it tolerates a slightly longer shared cache than the live listing. Keyed by page only.
const SOLD_MAX_AGE = 30

export default defineCachedEventHandler(event => listSoldPage(parsePageParams(event)), {
  maxAge: SOLD_MAX_AGE,
  swr: true,
  getKey: event => {
    const { page, pageSize } = parsePageParams(event)
    return `sold:${page}:${pageSize}`
  },
})
