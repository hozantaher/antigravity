import { getAuthAdmin } from '../../utils/firebase'
import { setTokensValidAfter } from '../../repos/userRepo'

// DB cutoff (tokens_valid_after) gates access — survives a Firebase outage;
// revokeRefreshTokens is best-effort.
export default defineEventHandler(async event => {
  const session = await requireSession(event)

  await setTokensValidAfter(session.id, new Date())

  let revoked = false
  try {
    await getAuthAdmin().revokeRefreshTokens(session.id)
    revoked = true
  } catch {
    // best-effort; the DB cutoff already invalidated existing tokens
  }

  return { ok: true, revoked }
})
