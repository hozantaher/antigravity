import { verifyIdToken } from '../../utils/firebase'
import { createOrGetUser, syncAuthFields } from '../../repos/userRepo'

// Exchange a Firebase ID token for the app user. First verified login creates
// the row (optionally seeded with the registration profile). Returns the User.
export default defineEventHandler(async event => {
  const body = await readBody(event).catch(() => ({}))
  const idToken = body?.idToken
  if (!idToken || typeof idToken !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Missing idToken' })
  }

  let decoded
  try {
    decoded = await verifyIdToken(idToken)
  } catch {
    throw createError({ statusCode: 401, statusMessage: 'Invalid Firebase ID token' })
  }

  // v1 has no transactional email service wired, so we don't gate on email
  // verification here (that would make password login impossible). Revisit if
  // SendGrid/etc. is added later.
  const user = await createOrGetUser(
    {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name,
      emailVerified: !!decoded.email_verified,
      signInProvider: decoded.firebase?.sign_in_provider,
    },
    body?.profile,
  )

  // Firebase owns email + verification; mirror current claims onto an existing
  // row so a just-verified email (or email change) takes effect on next login.
  const synced = await syncAuthFields(decoded.uid, {
    email: decoded.email,
    emailVerified: !!decoded.email_verified,
  })

  return synced ?? user
})
