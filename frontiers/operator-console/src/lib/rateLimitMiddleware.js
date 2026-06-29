// Paths exempted entirely from BFF rate limiting (no bucket increment, no
// 429). `/api/health` is whitelisted because the dashboard polls it for the
// "degraded" banner and an aggressive limit would flap the UI.
const RATE_LIMIT_EXEMPT_PREFIX = '/api/health'

// Read-only paths that legitimately burst above the global default. The
// Mailboxes page opens multiple drawers in parallel and each drawer fires
// 4 GETs (full-check, check-history, imap-inbox, watchdog-events). Three
// drawers ~= 12 reqs in <1s. Bumping these to a higher per-IP ceiling
// lets the page render without 429s while keeping the global limit tight
// for write paths.
//
// Caught by the 2026-04-30 visual smoke test (Mailboxes page returned 429
// on a fresh load with three open drawers).
const RATE_LIMIT_HIGH_BURST_PREFIXES = ['/api/mailboxes']
const HIGH_BURST_MAX_PER_MIN = 60

// iter62: default per-IP ceiling. This dashboard is a LOCAL, single-account
// tool (operator + one employee on the same account, feedback_outreach_dashboard_local_only)
// — the limiter exists only as a runaway-loop backstop, NOT public-abuse defense.
// The old 100/min throttled NORMAL nav: each list page fires 20-31 API reqs, so
// ~4 page loads or a handful of opened reply threads (each /api/replies/:id +
// /api/threads/:id) exhausted the bucket and 429-stormed the employee mid-triage
// (verified by the iter62 brutal pass). 400/min ≈ 13+ page loads per minute —
// generous headroom for a focused human while still bounding a genuine runaway.
// 1000/min ≈ 16 req/s — a focused human (or the +1 employee on the same
// account) browsing several tabs never approaches it, while a genuine runaway
// client loop (thousands/min, e.g. a useResource regression or the chaos
// monkey at 3.5 actions/s × ~25 reqs/nav) still trips it. On a localhost,
// single-IP, 2-user tool the limiter is ONLY a runaway backstop — not
// public-abuse defense — so the ceiling is set well above any legitimate use.
const DEFAULT_MAX_PER_MIN = 1000

export function createRateLimitMiddleware({
  max = DEFAULT_MAX_PER_MIN,
  windowMs = 60_000,
  highBurstMax = HIGH_BURST_MAX_PER_MIN,
  highBurstPrefixes = RATE_LIMIT_HIGH_BURST_PREFIXES,
} = {}) {
  // Two parallel buckets per IP: the "default" bucket for everything and a
  // "high-burst" bucket scoped to whitelisted read prefixes. They don't share
  // counters, so a Mailboxes page burst can't starve a write request and a
  // POST campaign send can't push the read paths into 429.
  const defaultStore = new Map()
  const highBurstStore = new Map()

  function tick(store, key, ceiling, now) {
    let entry = store.get(key)
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs }
      store.set(key, entry)
    }
    entry.count++
    return entry.count <= ceiling
  }

  return function rateLimitMiddleware(req, res, next) {
    if (process.env.BFF_RATE_LIMIT_DISABLED === '1') return next()
    if (req.path.startsWith(RATE_LIMIT_EXEMPT_PREFIX)) return next()

    const ip  = req.ip || req.socket?.remoteAddress || 'unknown'
    const now = Date.now()

    const isHighBurst = highBurstPrefixes.some(p => req.path.startsWith(p))
    const allowed = isHighBurst
      ? tick(highBurstStore, ip, highBurstMax, now)
      : tick(defaultStore,   ip, max,          now)

    if (!allowed) {
      return res.status(429).json({ error: 'too many requests' })
    }
    return next()
  }
}
