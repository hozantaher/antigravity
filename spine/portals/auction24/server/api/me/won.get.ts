import { listWonItemsPage } from '~/server/repos/itemRepo'

// Auctions the session user won — the activity hub's "won" view, surfacing wins that today are only
// reachable via the win e-mail. Settled or awaiting settlement; the card status carries the rest.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  return listWonItemsPage(user.id, parsePageParams(event, { defaultPageSize: 24 }))
})
