import { requireSession } from '../../../../utils/session'
import { enforceRateLimit } from '../../../../utils/rateLimit'
import { issueSaleTransfer } from '../../../../utils/settlement'
import { findSettlementCandidate, settlementError } from '../../../../repos/settlementRepo'

// Starts (or resumes) a bank-transfer sale payment: find-or-creates the type='sale' invoice and
// returns the bank details + SPAYD string. Idempotent (reuses the open sale invoice). When the deposit
// fully covers the price (amountDue === 0) the invoice settles internally and `state` is 'completed'.
// POST — server-side side effect. Winner-gated; 409 if already settled.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  const itemId = getRouterParam(event, 'id')
  if (!itemId) throw createError({ statusCode: 400, statusMessage: 'Missing item id' })
  enforceRateLimit(event, { bucket: 'settlement-transfer', limit: 5, windowMs: 60_000, key: user.id })

  const candidate = await findSettlementCandidate(itemId)
  if (!candidate) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

  const gate = settlementError({
    userId: user.id,
    sold: candidate.sold,
    closed: candidate.closed,
    winnerId: candidate.winnerId,
    // A paid (or completion-stamped) sale must not re-open a transfer.
    alreadyCompleted: candidate.settledAt != null || candidate.invoice?.status === 'paid',
  })
  if (gate) throw createError({ statusCode: gate.status, statusMessage: gate.code })

  return await issueSaleTransfer(itemId, user.id)
})
