import { getAuthAdmin, verifyIdToken } from '../../utils/firebase'
import { extractBearerToken } from '../../utils/session'
import { enqueueEmail } from '../../utils/emailQueue'
import { enforceRateLimit } from '../../utils/rateLimit'
import { resolveRequestLocale } from '../../utils/requestLocale'
import { buildOobActionUrl, failEmailAction } from '../../utils/authEmail'

// Replaces Firebase's default verification e-mail: Admin SDK mints the verify link
// without sending anything, then we deliver our own MJML template via SendGrid.
export default defineEventHandler(async event => {
  // Authenticated by the caller's Firebase ID token — the verification e-mail can
  // only ever go to that token's own address, so there's no enumeration vector.
  const token = extractBearerToken(getHeader(event, 'authorization'))
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Authentication required' })

  let decoded
  try {
    decoded = await verifyIdToken(token)
  } catch {
    throw createError({ statusCode: 401, statusMessage: 'Invalid Firebase ID token' })
  }

  enforceRateLimit(event, { bucket: 'email-verification', limit: 5, windowMs: 60_000, key: decoded.uid })

  const email = decoded.email
  if (!email) throw createError({ statusCode: 400, statusMessage: 'Token has no email claim' })

  // Already verified — nothing to send.
  if (decoded.email_verified === true) return { sent: false }

  const language = resolveRequestLocale(event)

  let verificationUrl: string
  try {
    const firebaseLink = await getAuthAdmin().generateEmailVerificationLink(email)
    verificationUrl = buildOobActionUrl(event, firebaseLink, '/auth/verify')
  } catch (e) {
    return failEmailAction(e, 'auth.request-email-verification', 'Failed to start email verification')
  }

  try {
    await enqueueEmail(
      { recipient: email, templateKey: 'sendVerificationEmail', language, params: { verificationUrl } },
      { mustDeliver: true },
    )
  } catch (e) {
    return failEmailAction(e, 'auth.request-email-verification.email', 'Failed to send verification email')
  }

  // JSON body, never a bare 204: an empty 204 to this POST makes the browser
  // re-send, which would enqueue a duplicate verification e-mail.
  return { sent: true }
})
