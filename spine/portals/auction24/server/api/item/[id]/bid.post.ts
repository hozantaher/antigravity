import { isUserEligibleToBid } from '~/models'
import { placeBid, getTopBidderId } from '~/server/repos/itemRepo'
import { notifyOutbid } from '~/server/utils/notify'

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const user = await requireSession(event)
  // Keyed on user.id (not IP): every other state-changing endpoint is rate-limited; without it a
  // depositor can flood failing bids and serialize a hot item on its FOR UPDATE row lock.
  enforceRateLimit(event, { bucket: 'bid', limit: 20, windowMs: 60_000, key: user.id })
  if (!isUserEligibleToBid(user)) {
    throw createError({ statusCode: 403, statusMessage: 'Not eligible to bid' })
  }
  const body = await readBody(event)
  const amount = Number(body?.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid bid amount' })
  }
  // Who currently leads — read before the bid so we know whom this bid is about to outbid. Best-effort
  // (a race here only mis-targets a notification, never the bid itself).
  const previousLeader = await getTopBidderId(id)
  const item = await placeBid(id, user.id, amount)
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Item not found' })
  if (previousLeader && previousLeader !== user.id) await notifyOutbid(id, previousLeader, item.title)
  return item
})
