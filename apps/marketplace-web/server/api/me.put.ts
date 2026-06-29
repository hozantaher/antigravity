import { updateUserProfile } from '~/server/repos/userRepo'

// Persist self-editable profile fields for the authenticated user. The repo
// whitelists which columns a user may change (no email/roles/deposit).
export default defineEventHandler(async event => {
  const session = await requireSession(event)
  const body = await readBody(event)
  const user = await updateUserProfile(session.id, body ?? {})
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })
  return user
})
