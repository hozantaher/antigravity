import { requireSession } from '../../../utils/session'
import { enforceRateLimit } from '../../../utils/rateLimit'
import { getSettlementStatus } from '../../../utils/settlement'
import { findSettlementCandidate, settlementError } from '../../../repos/settlementRepo'

// Polled by the settlement wizard until the payment lands. Read-only, winner-gated:
// due → pending → paid → completed. 403 for a non-winner, 404 for a non-candidate item.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  const itemId = getRouterParam(event, 'id')
  if (!itemId) throw createError({ statusCode: 400, statusMessage: 'Missing item id' })
  enforceRateLimit(event, { bucket: 'settlement-status', limit: 120, windowMs: 300_000, key: user.id })

  const candidate = await findSettlementCandidate(itemId)
  if (!candidate) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

  const gate = settlementError({
    userId: user.id,
    sold: candidate.sold,
    closed: candidate.closed,
    winnerId: candidate.winnerId,
    // The status endpoint must keep serving a COMPLETED sale (the wizard polls to success), so it does
    // not treat completion as a gate failure — only the mutating endpoints do.
    alreadyCompleted: false,
  })
  if (gate) throw createError({ statusCode: gate.status, statusMessage: gate.code })

  return await getSettlementStatus(itemId)
})
