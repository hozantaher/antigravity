import { requireSession } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { getDepositStatus } from '../../utils/deposit'

// Polled by the deposit wizard (~every 10 s) until the payment lands. Read-only.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  enforceRateLimit(event, { bucket: 'deposit-status', limit: 120, windowMs: 300_000, key: user.id })
  return await getDepositStatus(user.id)
})
