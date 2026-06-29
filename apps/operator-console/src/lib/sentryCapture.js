import * as Sentry from '@sentry/node'

/**
 * Derives a Sentry fingerprint array from a caught error.
 *
 * Rules (first match wins):
 *  - null / undefined / falsy          → ["generic-error"]
 *  - has a non-empty .code string      → ["db-error", code]   (pg error codes, ECONNREFUSED, …)
 *  - status 401/403 or auth message    → ["auth-error"]
 *  - status 404 or "not found" msg     → ["not-found"]
 *  - anything else                     → ["{{ default }}"]    (Sentry default grouping)
 *
 * @param {unknown} e
 * @returns {string[]}
 */
export function getFingerprint(e) {
  if (e == null) return ['generic-error']

  // PostgreSQL / Node.js error codes (ECONNREFUSED, 23505, 42P01, …)
  if (e?.code && typeof e.code === 'string' && e.code.length > 0) {
    return ['db-error', e.code]
  }

  // Auth errors — status 401/403 or message patterns
  if (
    e?.status === 401 ||
    e?.status === 403 ||
    /auth|unauthorized|forbidden/i.test(e?.message || '')
  ) {
    return ['auth-error']
  }

  // Not-found errors — status 404 or message pattern
  if (
    e?.status === 404 ||
    /not found/i.test(e?.message || '')
  ) {
    return ['not-found']
  }

  // Fall through to Sentry default grouping
  return ['{{ default }}']
}

/**
 * Captures an exception in Sentry with enriched fingerprinting and scope tags,
 * then sends a standardised JSON error response.
 *
 * Drop-in replacement for the `} catch (e) { res.status(500).json({ error: safeError(e) }) }` pattern.
 *
 * Improvements over the basic version:
 *  - custom fingerprinting groups similar errors together in Sentry
 *  - error.message_prefix tag for quick triage without opening the full event
 *  - wraps non-Error objects so Sentry always receives an Error instance
 *  - double-guarded: Sentry failure never blocks the HTTP response
 *
 * @param {import('express').Response} res
 * @param {unknown} e          - caught value
 * @param {(e: unknown) => string} safeError - project's safeError() fn
 * @param {number} [status=500]
 */
export function capture500(res, e, safeError, status = 500) {
  // Layer 1 (auto-detection): always log to stdout so BFF tail shows the
  // actual stack. Previously errors went to Sentry only — incident 2026-05-16
  // dashboard cascade was silent locally because of that.
  if (e instanceof Error) {
    console.error('[capture500]', status, e.message, '\n', e.stack?.split('\n').slice(0, 6).join('\n'))
  } else if (e != null) {
    console.error('[capture500]', status, String(e))
  }
  try {
    if (e instanceof Error || (e != null && typeof e === 'object')) {
      Sentry.withScope((scope) => {
        scope.setFingerprint(getFingerprint(e))
        const msg = e?.message
        if (msg && typeof msg === 'string') {
          scope.setTag('error.message_prefix', msg.slice(0, 50))
        }
        const errToCapture =
          e instanceof Error ? e : new Error(String(e?.message || 'unknown'))
        Sentry.captureException(errToCapture)
      })
    }
  } catch {
    // Never let Sentry failure block the response
  }
  return res.status(status).json({ error: safeError(e) })
}

export const captureAndRespond = capture500
