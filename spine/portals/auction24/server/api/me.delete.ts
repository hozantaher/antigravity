import { requireSession } from '../utils/session'
import { getAuthAdmin } from '../utils/firebase'
import { softDeleteUser } from '../repos/userRepo'

// Account deletion: remove the Firebase identity (so the user can never sign in
// again) and soft-delete the DB row. The row is kept — bids/items reference it via
// ON DELETE RESTRICT — but anonymized, token-revoked, and its e-mail freed.
export default defineEventHandler(async event => {
  const session = await requireSession(event)

  try {
    await getAuthAdmin().deleteUser(session.id)
  } catch (e) {
    // The Firebase user may already be gone; the DB soft-delete below is the gate.
    console.error('[auth.me.delete] firebase deleteUser failed', e)
  }

  await softDeleteUser(session.id)
  return { ok: true }
})
