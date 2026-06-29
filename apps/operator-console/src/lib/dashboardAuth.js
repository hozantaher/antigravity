// dashboardAuth.js — AW-F1 (2026-05-20)
//
// Local HTTP Basic Auth gate for the outreach-dashboard BFF. Single
// account, bcrypt-hashed password, env-driven.
//
// Default DISABLED for backwards compat (DASHBOARD_AUTH_ENABLED=false).
// When enabled, every request gets gated through a Basic Auth challenge
// EXCEPT a small bypass list (health checks, sentry tunnel, schema
// probe). The existing BFF_AUTH_DISABLED=1 test bypass is honored so the
// existing contract/unit suites keep passing.
//
// Why Basic Auth and not a session/login form: this is a single-user
// local-only dashboard (HARD rule feedback_outreach_dashboard_local_only
// T0). The operator's browser stores credentials per-origin; no cookie
// jar / CSRF surface / login UI to maintain. The X-API-Key middleware
// stays in front of /api/* (this is additive, not a replacement).
//
// PII discipline: passwords never appear in source, commands, env files,
// or logs (feedback_no_pii_in_commands T0). The CLI helper
// (scripts/set-dashboard-password.js) reads stdin only and prints the
// bcrypt hash for the operator to paste manually.
//
// HARD rules touched:
//   - feedback_no_pii_in_commands T0
//   - feedback_no_magic_thresholds T0 — bcrypt cost factor + realm string
//     as named module constants
//   - feedback_extreme_testing T0 — security-adjacent → unit + contract +
//     Playwright smoke

import bcrypt from 'bcryptjs'
import { timingSafeEqual } from 'node:crypto'

// Named constants per feedback_no_magic_thresholds T0.
export const BCRYPT_COST_FACTOR = 12
export const REALM = 'Hozan Taher Dashboard'

// Bypass paths: health probes + sentry tunnel + boot schema-check must
// never 401 even when auth is enabled — otherwise operator's own
// monitoring (Railway healthcheck, browser Sentry envelope, Vite proxy
// boot check) starts cascading red.
//
// Mirrors AUTH_EXEMPT shape in authMiddleware.js. /api/health/* gets a
// prefix match because the existing health surface has many sub-routes.
export const DASHBOARD_AUTH_BYPASS_PATHS = [
  '/health',
  '/healthz',
  '/api/health',
  '/api/sentry/tunnel',
  '/sentry-tunnel',
  '/__schema-check',
  '/api/__schema-check',
]

// Returns true if the request path should bypass dashboard auth.
export function isBypassPath(path) {
  if (typeof path !== 'string') return false
  for (const p of DASHBOARD_AUTH_BYPASS_PATHS) {
    if (path === p) return true
    if (path.startsWith(p + '/')) return true
  }
  return false
}

// Constant-time username comparison. Pads both buffers to the longer
// length so a length-mismatch doesn't leak via early-exit timing.
function safeUserEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  const maxLen = Math.max(bufA.length, bufB.length, 1)
  const padA = Buffer.alloc(maxLen, 0)
  const padB = Buffer.alloc(maxLen, 0)
  bufA.copy(padA)
  bufB.copy(padB)
  const eq = timingSafeEqual(padA, padB)
  return eq && bufA.length === bufB.length
}

// Parses `Authorization: Basic <base64(user:pass)>` into { user, pass }.
// Returns null on any structural failure (no header, wrong scheme,
// malformed base64, missing colon).
export function parseBasicAuthHeader(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return null
  // RFC 7617: scheme is case-insensitive, single space separator.
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(headerValue)
  if (!m) return null
  let decoded
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8')
  } catch {
    return null
  }
  const idx = decoded.indexOf(':')
  if (idx < 0) return null
  return {
    user: decoded.slice(0, idx),
    pass: decoded.slice(idx + 1),
  }
}

// Sends the 401 challenge response with WWW-Authenticate header set.
function send401(res) {
  res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
  return res.status(401).json({ error: 'unauthorized' })
}

// Express middleware factory. Reads env per-request so test setups and
// env flips take effect without restart (mirrors authMiddleware.js).
export function requireDashboardAuth(req, res, next) {
  // Test bypass — existing pattern preserved so contract/unit suites stay
  // green without the dashboard knowing about basic auth.
  if (process.env.BFF_AUTH_DISABLED === '1') return next()

  // Feature flag — disabled by default. Backwards compat.
  const enabled = process.env.DASHBOARD_AUTH_ENABLED === 'true'
  if (!enabled) return next()

  // Bypass list for monitoring endpoints.
  if (isBypassPath(req.path)) return next()

  const expectedUser = process.env.DASHBOARD_USER
  const expectedHash = process.env.DASHBOARD_PASS_HASH
  if (!expectedUser || !expectedHash) {
    // Misconfiguration: enabled but no credentials provisioned. Fail
    // closed with a distinctive error so the operator sees the gap
    // immediately instead of being silently locked out with a 401 they
    // can't fix.
    // eslint-disable-next-line no-console
    console.warn('[dashboardAuth] DASHBOARD_AUTH_ENABLED=true but DASHBOARD_USER or DASHBOARD_PASS_HASH missing')
    return res.status(503).json({ error: 'dashboard_auth_misconfigured' })
  }

  const parsed = parseBasicAuthHeader(req.headers?.authorization)
  if (!parsed) return send401(res)

  if (!safeUserEqual(parsed.user, expectedUser)) {
    return send401(res)
  }

  // bcrypt.compare is itself constant-time over the hash structure.
  // Wrap in try/catch because compareSync throws on malformed hashes
  // (e.g. if operator pasted a partial value).
  let ok = false
  try {
    ok = bcrypt.compareSync(parsed.pass, expectedHash)
  } catch {
    ok = false
  }
  if (!ok) return send401(res)

  return next()
}
