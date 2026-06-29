import { isDepositCurrency } from '~/models'
import { requireSession } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { issueDepositTransfer } from '../../utils/deposit'

// Starts (or resumes) a bank-transfer deposit payment: issues the unpaid proforma
// and returns the bank details + SPAYD string the wizard renders. POST, not a
// query — it has a server-side side effect.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  enforceRateLimit(event, { bucket: 'deposit-transfer', limit: 5, windowMs: 60_000, key: user.id })

  const body = await readBody(event).catch(() => undefined)
  const currency: unknown = body?.currency
  if (!isDepositCurrency(currency)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid currency' })
  }

  return await issueDepositTransfer(user.id, currency)
})
