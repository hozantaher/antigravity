import { getAuthAdmin } from '../../utils/firebase'
import { enqueueEmail } from '../../utils/emailQueue'
import { enforceRateLimit } from '../../utils/rateLimit'
import { captureServerError } from '../../utils/observability'
import { resolveRequestLocale } from '../../utils/requestLocale'
import { buildOobActionUrl, failEmailAction } from '../../utils/authEmail'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Replaces Firebase's default reset e-mail: Admin SDK mints the reset link without
// sending anything, then we deliver our own MJML template via SendGrid.
export default defineEventHandler(async event => {
  // Unauthenticated and triggers an e-mail — throttle to curb abuse / enumeration.
  enforceRateLimit(event, { bucket: 'password-reset', limit: 5, windowMs: 60_000 })

  const body = await readBody(event).catch(() => ({}))
  const rawEmail = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!EMAIL_RE.test(rawEmail)) throw createError({ statusCode: 400, statusMessage: 'Invalid payload' })
  const localeRaw = typeof body?.locale === 'string' ? body.locale.trim() : undefined

  const email = rawEmail.toLowerCase()
  const language = resolveRequestLocale(event, localeRaw)
  const auth = getAuthAdmin()

  // Existence check first: getUserByEmail returns a clean `auth/user-not-found`,
  // whereas generatePasswordResetLink for a missing account throws a generic error.
  try {
    await auth.getUserByEmail(email)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code !== 'auth/user-not-found') captureServerError(e, { area: 'auth.request-password-reset.lookup' })
    // Anti-enumeration: unknown address responds like a hit and sends nothing.
    return { ok: true }
  }

  let resetUrl: string
  try {
    const firebaseLink = await auth.generatePasswordResetLink(email)
    resetUrl = buildOobActionUrl(event, firebaseLink, '/auth/reset')
  } catch (e) {
    return failEmailAction(e, 'auth.request-password-reset', 'Failed to start password reset')
  }

  try {
    await enqueueEmail(
      { recipient: email, templateKey: 'resetPassword', language, params: { resetUrl } },
      { mustDeliver: true },
    )
  } catch (e) {
    return failEmailAction(e, 'auth.request-password-reset.email', 'Failed to send password reset email')
  }

  // JSON body, never a bare 204: an empty 204 to this POST makes the browser
  // re-send, which would enqueue a duplicate reset e-mail.
  return { ok: true }
})
