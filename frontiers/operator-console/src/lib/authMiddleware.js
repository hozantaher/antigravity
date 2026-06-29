import { addAuthBreadcrumb } from '../../sentry.server.js'
import { timingSafeEqual } from 'node:crypto'

// Constant-time string comparison using crypto.timingSafeEqual.
// Prevents timing side-channel attacks that could allow byte-by-byte key
// recovery by measuring response latency differences.
function safeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    // Length mismatch: still do a dummy comparison to avoid timing leak on length
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export const AUTH_EXEMPT = [
  '/api/health',
  '/api/health/system',
  '/api/health/drift',
  '/api/health/guards',
  '/api/health/auth-fail-alerts',
  '/api/version',
  '/api/daemons',
  // Public unsubscribe — recipient clicks a link from their email, no
  // X-API-Key available. Token is HMAC-validated server-side, so the
  // endpoint is safe to expose without auth.
  '/unsubscribe',
]

export function createAuthMiddleware() {
  // BFF_AUTH_DISABLED is read per-request (not cached at init) so test
  // setups and dev env flips take effect without restart. Used by
  // test/contract/setup.ts and local dev.
  return function authMiddleware(req, res, next) {
    if (process.env.BFF_AUTH_DISABLED === '1') return next()
    if (AUTH_EXEMPT.includes(req.path)) return next()
    const key = process.env.OUTREACH_API_KEY
    if (!key) {
      addAuthBreadcrumb('missing OUTREACH_API_KEY configuration')
      return res.status(401).json({ error: 'unauthorized' })
    }
    // EventSource cannot set custom headers, so accept the API key as a
    // query parameter for SSE-style endpoints (?token=<api-key>). Header
    // path is still preferred — query is the fallback when the browser
    // can't set headers.
    const headerKey = req.headers['x-api-key']
    const queryKey = req.query?.token
    if (!safeStringEqual(headerKey, key) && !safeStringEqual(queryKey, key)) {
      const reason = headerKey
        ? 'invalid X-API-Key header'
        : queryKey
          ? 'invalid token query'
          : 'missing X-API-Key header'
      addAuthBreadcrumb(reason)
      return res.status(401).json({ error: 'unauthorized' })
    }
    return next()
  }
}
