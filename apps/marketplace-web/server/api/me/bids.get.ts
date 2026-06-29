import { listBidItemsPage } from '~/server/repos/itemRepo'

// Auctions the session user has bid on — the activity hub's "active bids" view. SSR is anonymous, so
// this resolves client-side once the bearer token attaches.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  return listBidItemsPage(user.id, parsePageParams(event, { defaultPageSize: 24 }))
})
