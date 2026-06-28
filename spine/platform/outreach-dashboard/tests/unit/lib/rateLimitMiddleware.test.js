import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimitMiddleware } from '../../../src/lib/rateLimitMiddleware.js'

// Default path is a write-ish API not on the high-burst whitelist so the
// generic-bucket tests below see the configured `max` ceiling. Tests that
// exercise the high-burst bucket override `path` explicitly.
function makeReq(ip = '127.0.0.1', path = '/api/campaigns') {
  return { ip, path, headers: {}, socket: { remoteAddress: ip } }
}
function makeRes() {
  const res = { _status: null, _body: null, _headers: {} }
  res.status     = (s) => { res._status = s; return res }
  res.json       = (b) => { res._body   = b; return res }
  res.setHeader  = (k, v) => { res._headers[k] = v }
  return res
}

describe('createRateLimitMiddleware', () => {
  let clock
  let savedDisabled

  beforeEach(() => {
    clock = vi.useFakeTimers()
    // Under TEST_SCOPE=all/contract vitest sets BFF_RATE_LIMIT_DISABLED=1
    // globally so contract handlers don't 429. Tests of the rate-limit
    // middleware itself must run with it cleared (the dedicated
    // "BFF_RATE_LIMIT_DISABLED=1 bypasses both buckets" test sets it
    // back inside its own try/finally).
    savedDisabled = process.env.BFF_RATE_LIMIT_DISABLED
    delete process.env.BFF_RATE_LIMIT_DISABLED
  })
  afterEach(() => {
    if (savedDisabled === undefined) delete process.env.BFF_RATE_LIMIT_DISABLED
    else process.env.BFF_RATE_LIMIT_DISABLED = savedDisabled
  })

  // T-0363: requests under limit pass through
  it('allows requests under the limit', () => {
    const mw = createRateLimitMiddleware({ max: 5, windowMs: 1000 })
    for (let i = 0; i < 5; i++) {
      const next = vi.fn()
      mw(makeReq(), makeRes(), next)
      expect(next).toHaveBeenCalledOnce()
    }
  })

  // T-0364: requests over limit get 429
  it('returns 429 when limit exceeded', () => {
    const mw = createRateLimitMiddleware({ max: 3, windowMs: 1000 })
    const ip = '10.0.0.1'
    for (let i = 0; i < 3; i++) mw(makeReq(ip), makeRes(), vi.fn())
    const res  = makeRes()
    const next = vi.fn()
    mw(makeReq(ip), res, next)
    expect(res._status).toBe(429)
    expect(res._body).toMatchObject({ error: expect.any(String) })
    expect(next).not.toHaveBeenCalled()
  })

  // T-0365: window resets after windowMs
  it('resets count after window expires', () => {
    const mw = createRateLimitMiddleware({ max: 2, windowMs: 500 })
    const ip = '10.0.0.2'
    for (let i = 0; i < 2; i++) mw(makeReq(ip), makeRes(), vi.fn())
    clock.advanceTimersByTime(600)
    const next = vi.fn()
    mw(makeReq(ip), makeRes(), next)
    expect(next).toHaveBeenCalledOnce()
  })

  // T-0366: different IPs have independent counters
  it('tracks IPs independently', () => {
    const mw = createRateLimitMiddleware({ max: 2, windowMs: 1000 })
    for (let i = 0; i < 2; i++) mw(makeReq('1.1.1.1'), makeRes(), vi.fn())
    const next = vi.fn()
    mw(makeReq('2.2.2.2'), makeRes(), next)
    expect(next).toHaveBeenCalledOnce()
  })

  // T-0367: health endpoints exempt from rate limiting
  it('skips rate limit for /api/health paths', () => {
    const mw = createRateLimitMiddleware({ max: 1, windowMs: 1000 })
    const ip = '10.0.0.3'
    mw(makeReq(ip, '/api/health'), makeRes(), vi.fn())
    const next = vi.fn()
    mw(makeReq(ip, '/api/health'), makeRes(), next)
    expect(next).toHaveBeenCalledOnce()
  })

  // 2026-04-30 — high-burst bucket for read-heavy paths.
  // Visual smoke caught the Mailboxes page bursting ~12 reqs in <1s and
  // tripping the global limit. /api/mailboxes/* now lives in a separate
  // bucket with a higher ceiling.

  it('lets /api/mailboxes/* burst above the default max', () => {
    // Default max=2 for the generic bucket. /api/mailboxes/* should still
    // get through because it counts against the high-burst bucket only.
    const mw = createRateLimitMiddleware({
      max: 2, windowMs: 1000, highBurstMax: 12,
    })
    const ip = '10.0.0.10'
    for (let i = 0; i < 12; i++) {
      const next = vi.fn()
      mw(makeReq(ip, '/api/mailboxes/123/full-check'), makeRes(), next)
      expect(next).toHaveBeenCalledOnce()
    }
  })

  it('high-burst bucket eventually 429s when its own ceiling is hit', () => {
    const mw = createRateLimitMiddleware({
      max: 100, windowMs: 1000, highBurstMax: 3,
    })
    const ip = '10.0.0.11'
    for (let i = 0; i < 3; i++) {
      mw(makeReq(ip, '/api/mailboxes'), makeRes(), vi.fn())
    }
    const res = makeRes()
    mw(makeReq(ip, '/api/mailboxes'), res, vi.fn())
    expect(res._status).toBe(429)
  })

  it('default and high-burst buckets are independent (one cannot starve the other)', () => {
    const mw = createRateLimitMiddleware({
      max: 2, windowMs: 1000, highBurstMax: 2,
    })
    const ip = '10.0.0.12'
    // Saturate generic bucket via /api/campaigns.
    mw(makeReq(ip, '/api/campaigns'), makeRes(), vi.fn())
    mw(makeReq(ip, '/api/campaigns'), makeRes(), vi.fn())
    const blockedRes = makeRes()
    mw(makeReq(ip, '/api/campaigns'), blockedRes, vi.fn())
    expect(blockedRes._status).toBe(429)
    // /api/mailboxes still has its own room.
    const okNext = vi.fn()
    mw(makeReq(ip, '/api/mailboxes'), makeRes(), okNext)
    expect(okNext).toHaveBeenCalledOnce()
  })

  it('treats nested mailbox subroutes (full-check, watchdog-events) as high-burst', () => {
    const mw = createRateLimitMiddleware({
      max: 1, windowMs: 1000, highBurstMax: 5,
    })
    const ip = '10.0.0.13'
    const paths = [
      '/api/mailboxes',
      '/api/mailboxes/42',
      '/api/mailboxes/42/full-check',
      '/api/mailboxes/42/check-history',
      '/api/mailboxes/42/watchdog-events?limit=10',
    ]
    for (const p of paths) {
      const next = vi.fn()
      mw(makeReq(ip, p), makeRes(), next)
      expect(next).toHaveBeenCalledOnce()
    }
  })

  it('BFF_RATE_LIMIT_DISABLED=1 bypasses both buckets', () => {
    const prev = process.env.BFF_RATE_LIMIT_DISABLED
    process.env.BFF_RATE_LIMIT_DISABLED = '1'
    try {
      const mw = createRateLimitMiddleware({
        max: 1, windowMs: 1000, highBurstMax: 1,
      })
      const ip = '10.0.0.14'
      for (let i = 0; i < 50; i++) {
        const next = vi.fn()
        mw(makeReq(ip, '/api/mailboxes'), makeRes(), next)
        expect(next).toHaveBeenCalledOnce()
      }
    } finally {
      if (prev === undefined) delete process.env.BFF_RATE_LIMIT_DISABLED
      else process.env.BFF_RATE_LIMIT_DISABLED = prev
    }
  })

  it('high-burst window also resets after windowMs', () => {
    const mw = createRateLimitMiddleware({
      max: 100, windowMs: 500, highBurstMax: 2,
    })
    const ip = '10.0.0.15'
    mw(makeReq(ip, '/api/mailboxes'), makeRes(), vi.fn())
    mw(makeReq(ip, '/api/mailboxes'), makeRes(), vi.fn())
    const blocked = makeRes()
    mw(makeReq(ip, '/api/mailboxes'), blocked, vi.fn())
    expect(blocked._status).toBe(429)
    clock.advanceTimersByTime(600)
    const ok = vi.fn()
    mw(makeReq(ip, '/api/mailboxes'), makeRes(), ok)
    expect(ok).toHaveBeenCalledOnce()
  })
})
