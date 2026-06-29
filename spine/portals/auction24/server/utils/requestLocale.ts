import { getRequestHeader, type H3Event } from 'h3'
import { EMAIL_LOCALES } from '../email/translations'

const SUPPORTED = new Set(EMAIL_LOCALES)
const DEFAULT_LOCALE = 'cz'
// Accept-Language two-letter heads that don't match our locale codes 1:1.
const ALIASES: Record<string, string> = { cs: 'cz', uk: 'ua', sr: 'rs' }

// Resolves the locale for a server-sent e-mail: explicit client locale, then the
// Accept-Language head, then the project default.
export const resolveRequestLocale = (event: H3Event, requested?: string): string => {
  const explicit = requested?.toLowerCase()
  if (explicit && SUPPORTED.has(explicit)) return explicit
  const accept = getRequestHeader(event, 'accept-language')
  if (accept) {
    const head = accept.slice(0, 2).toLowerCase()
    const code = ALIASES[head] ?? head
    if (SUPPORTED.has(code)) return code
  }
  return DEFAULT_LOCALE
}
