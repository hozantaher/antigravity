import { setNewsletterEnabled } from '../../repos/newsletterRepo'
import { verifyUnsubscribeToken } from '../../utils/newsletterBuilder'

// One-click unsubscribe from the newsletter (§12). The HMAC token (issued in the e-mail)
// authorizes the opt-out without a login, then we show a self-contained confirmation.
export default defineEventHandler(async event => {
  if (!useRuntimeConfig().internalApiSecret)
    throw createError({ statusCode: 503, statusMessage: 'Unsubscribe not configured' })

  const token = getQuery(event).token
  const userId = typeof token === 'string' ? verifyUnsubscribeToken(token) : null
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'Invalid token' })

  await setNewsletterEnabled(userId, false)

  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title></head><body style="font-family:'Lato',-apple-system,sans-serif;text-align:center;padding:48px 24px;color:#3f3f46"><h1 style="color:#1d315f;font-size:24px">Odhlášeno · Unsubscribed</h1><p style="font-size:16px">Byli jste odhlášeni z odběru newsletteru.<br>You have been unsubscribed from the newsletter.</p></body></html>`
})
