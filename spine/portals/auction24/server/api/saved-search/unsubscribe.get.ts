import { setAlertEnabled } from '../../repos/savedSearchRepo'
import { verifySavedSearchUnsubToken } from '../../utils/savedSearchAlerts'

// One-click "stop alerts" for a saved search. The HMAC token (issued in the alert email) authorizes
// disabling that one search's alert without a login; then we show a self-contained confirmation.
export default defineEventHandler(async event => {
  if (!useRuntimeConfig().internalApiSecret)
    throw createError({ statusCode: 503, statusMessage: 'Unsubscribe not configured' })

  const token = getQuery(event).token
  const id = typeof token === 'string' ? verifySavedSearchUnsubToken(token) : null
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Invalid token' })

  await setAlertEnabled(id, false)

  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alerts off</title></head><body style="font-family:'Lato',-apple-system,sans-serif;text-align:center;padding:48px 24px;color:#3f3f46"><h1 style="color:#1d315f;font-size:24px">Upozornění vypnuto · Alerts off</h1><p style="font-size:16px">Upozornění pro toto uložené hledání byla vypnuta.<br>Alerts for this saved search have been turned off.</p></body></html>`
})
