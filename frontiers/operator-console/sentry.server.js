import * as Sentry from '@sentry/node'
import { expressIntegration } from '@sentry/node'

const dsn = process.env.SENTRY_DSN_BFF
const env = process.env.NODE_ENV || 'development'

// MVP-4: release tag — mirrors services/common/telemetry.BuildReleaseTag.
// Without this, server-side Sentry events have no version anchor and
// hotfix dedup is impossible. Pulls SHA from the same env vars Railway
// + GitHub Actions populate.
function buildBffReleaseTag() {
  const sha =
    process.env.GIT_SHA ||
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.SOURCE_COMMIT ||
    process.env.GITHUB_SHA ||
    ''
  if (!sha) return undefined
  return `bff@${String(sha).slice(0, 12)}`
}
export const BFF_RELEASE = buildBffReleaseTag()

if (dsn) {
  Sentry.init({
    dsn,
    environment: env,
    release: BFF_RELEASE,
    integrations: [expressIntegration()],
    // 0 in development/test (no overhead), 5% in production
    // Set SENTRY_TRACES_SAMPLE_RATE env to override
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || (env === 'production' ? '0.05' : '0')),
    // Ignore expected client errors — only capture 5xx + unhandled
    ignoreErrors: [
      /not found/i,
      /already exists/i,
      /invalid/i,
      /unauthorized/i,
    ],
    // Filter out noisy non-actionable events, then trim PII from request bodies
    beforeSend(event) {
      // Drop health check requests — high volume, never actionable
      const url = event.request?.url || ''
      if (/\/(healthz?|metrics|ping|readyz?)($|\?)/.test(url)) {
        return null
      }
      // Drop 4xx — client errors, not our bug
      const status = event.contexts?.response?.status_code
      if (status && status >= 400 && status < 500) {
        return null
      }
      // Trim PII from request bodies
      if (event.request?.data) {
        const body = event.request.data
        if (typeof body === 'object' && body !== null) {
          const sanitized = { ...body }
          for (const key of ['password', 'token', 'api_key', 'secret']) {
            if (key in sanitized) sanitized[key] = '[Filtered]'
          }
          event.request.data = sanitized
        }
      }
      return event
    },
  })

  process.on('unhandledRejection', (reason) => {
    Sentry.captureException(reason)
  })
  process.on('uncaughtException', (err) => {
    Sentry.captureException(err)
  })
}

// Express middleware: enrich each request's Sentry scope with route + env tags
// and set user context from X-API-Key (last 4 chars only, never the full key).
// Mount early in the middleware chain (after Sentry init, before routes).
export function sentryTagMiddleware(req, res, next) {
  if (!process.env.SENTRY_DSN_BFF) return next()
  try {
    Sentry.withIsolationScope((scope) => {
      scope.setTag('http.method', req.method)
      scope.setTag('http.route', req.path?.split('/')[2] || 'root')
      scope.setTag('app.service', 'bff')

      const apiKey = req.headers['x-api-key']
      if (apiKey && typeof apiKey === 'string' && apiKey.length > 0) {
        Sentry.setUser({ id: `key:${apiKey.slice(-4)}` })
      }

      next()
    })
  } catch {
    // Never let Sentry failure block the request
    next()
  }
}

/**
 * Wraps an async operation in a Sentry span for performance monitoring.
 * Only active when tracesSampleRate > 0 and DSN is set.
 * No-op in production with tracesSampleRate: 0.
 *
 * @param {string} op - operation type (db.query, http.client, task)
 * @param {string} name - span name
 * @param {() => Promise<T>} fn - async operation
 * @returns {Promise<T>}
 */
export async function withSpan(op, name, fn) {
  if (!process.env.SENTRY_DSN_BFF) return fn()
  return Sentry.startSpan({ op, name }, fn)
}

/**
 * Wraps pool.query to emit a Sentry breadcrumb on every DB call.
 * When SENTRY_DSN_BFF is not set the original pool is returned unchanged.
 *
 * @param {object} pool - pg.Pool instance
 * @returns {object} - the (possibly wrapped) pool
 */
export function wrapPoolWithBreadcrumbs(pool) {
  if (!process.env.SENTRY_DSN_BFF) return pool
  if (!pool || typeof pool.query !== 'function') return pool

  const origQuery = pool.query.bind(pool)
  pool.query = async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0].slice(0, 100) : 'query'
    // Breadcrumb (existing)
    try {
      Sentry.addBreadcrumb({
        category: 'db.query',
        message: sql,
        level: 'info',
      })
    } catch {}
    // Span (new) — wraps the actual query execution
    return withSpan('db.query', sql.slice(0, 50), () => origQuery(...args))
  }
  return pool
}

/**
 * Records an auth failure as a Sentry breadcrumb with category=auth.
 * No-op when SENTRY_DSN_BFF is not configured.
 *
 * @param {string} reason - human-readable description of the auth failure
 */
export function addAuthBreadcrumb(reason) {
  if (!process.env.SENTRY_DSN_BFF) return
  try {
    const message = reason == null
      ? ''
      : typeof reason === 'string'
        ? reason
        : String(reason)
    Sentry.addBreadcrumb({
      category: 'auth',
      message,
      level: 'warning',
    })
  } catch {
    // never let breadcrumb instrumentation throw
  }
}

/**
 * Enriches the current Sentry isolation scope with route-specific tags.
 * Call from individual route handlers (campaigns, mailboxes, companies, …)
 * to attach context that helps triage errors in Sentry.
 *
 * Safe to call unconditionally — is a no-op when SENTRY_DSN_BFF is unset
 * and never throws (Sentry failure must never break the request).
 *
 * @param {Record<string, string | null | undefined>} tags
 */
export function setRouteTags(tags) {
  if (!process.env.SENTRY_DSN_BFF || !tags) return
  try {
    Sentry.withIsolationScope((scope) => {
      for (const [k, v] of Object.entries(tags)) {
        if (v != null) scope.setTag(k, String(v).slice(0, 100))
      }
    })
  } catch {
    // Never let tagging break the request
  }
}

export { Sentry }
