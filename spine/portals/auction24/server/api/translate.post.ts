import { requireAdmin } from '../utils/session'
import { enforceRateLimit } from '../utils/rateLimit'
import { translateTexts, DeeplError } from '../utils/deepl'

const mapDeeplToHttp = (err: DeeplError) => {
  switch (err.kind) {
    case 'not_configured':
      return createError({ statusCode: 503, statusMessage: 'DeepL is not configured' })
    case 'quota':
      return createError({ statusCode: 402, statusMessage: 'DeepL quota exceeded' })
    case 'rate_limited':
      return createError({ statusCode: 429, statusMessage: 'DeepL: too many requests' })
    case 'auth':
      return createError({ statusCode: 502, statusMessage: 'DeepL authentication error' })
    default:
      return createError({ statusCode: 502, statusMessage: 'DeepL service is unavailable' })
  }
}

// Admin-only: drives the item editor's "translate to other languages" action. Accepts a single
// string or an array; returns the translations in `texts` (input order). Empty/whitespace entries
// are passed through untranslated so the highlight index alignment in useAdminItem is preserved.
export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  enforceRateLimit(event, { bucket: 'admin-translate', limit: 120, windowMs: 60_000, key: admin.id })

  const body = await readBody(event).catch(() => ({}))
  const raw = body?.text
  const code = typeof body?.code === 'string' ? body.code : ''
  const sourceCode = typeof body?.sourceCode === 'string' ? body.sourceCode : undefined
  const inputs = (Array.isArray(raw) ? raw : [raw]).map(t => (typeof t === 'string' ? t : ''))

  if (!code) return { texts: inputs }

  const translatable = inputs.map((text, index) => ({ text, index })).filter(x => x.text.trim() !== '')
  if (!translatable.length) return { texts: inputs }

  try {
    const translated = await translateTexts(
      translatable.map(x => x.text),
      code,
      sourceCode,
    )
    const out = [...inputs]
    translatable.forEach((x, k) => (out[x.index] = translated[k] ?? x.text))
    return { texts: out }
  } catch (err) {
    if (err instanceof DeeplError) throw mapDeeplToHttp(err)
    throw err
  }
})
