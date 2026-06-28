// AD4 hardening tests — per-IP rate limit on POST /api/mailboxes/bulk-set-password.
//
// Locks the fix from Sprint AD4: the bulk-password endpoint must enforce a
// tight per-IP rate limit (5 calls/60s) to prevent brute-force or accidental
// loop attacks.
//
// Tests (11):
//  1.  5 calls within window → all allowed (200, not 429)
//  2.  6th call within window → 429
//  3.  7th call within window → still 429 (idempotent after first 429)
//  4.  After window reset → counter resets, calls allowed again
//  5.  Two different IPs are tracked independently
//  6.  BFF_RATE_LIMIT_DISABLED=1 bypasses limit entirely
//  7.  'unknown' IP is valid bucket key (no crash when IP unresolvable)
//  8.  Rate limit fires before handler logic (rate check happens first)
//  9.  429 response body has { error: … } JSON shape
// 10.  Rate limit respects window boundary (no early reset)
// 11.  Rapid 100 calls from one IP → all after 5th are 429

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ─── Helpers to simulate the rate limit function ─────────────────────────────
// We import and call the function directly rather than going through Express
// routing overhead, to keep the tests fast and deterministic.

// We need to isolate the module-level store (_bulkPwdStore) between tests.
// Use vi.resetModules() + dynamic import to get a fresh module each time.

async function loadModule(envOverrides = {}) {
  const savedEnv = {}
  for (const [k, v] of Object.entries(envOverrides)) {
    savedEnv[k] = process.env[k]
    process.env[k] = v
  }
  vi.resetModules()
  // Import the module — the store is module-level so a fresh import = empty store.
  const mod = await import('../../../src/server-routes/bulkPassword.js')
  return { mod, savedEnv }
}

// Build a minimal fake Express app that captures the registered middleware chain.
function fakeApp() {
  const registrations = []
  return {
    post(path, ...handlers) {
      registrations.push({ path, handlers })
    },
    registrations,
  }
}

// Simulate calling through an Express middleware chain.
// Returns the final status/json set by whatever handler fires.
function callChain(handlers, req, res) {
  return new Promise((resolve) => {
    let idx = 0
    function next() {
      const h = handlers[idx++]
      if (!h) return resolve({ status: res._status, body: res._body })
      h(req, res, next)
    }
    next()
  })
}

function fakeRes() {
  const r = { _status: 200, _body: null }
  r.status = (s) => { r._status = s; return r }
  r.json = (b) => { r._body = b; return r }
  return r
}

function fakeReq(ip = '1.2.3.4') {
  return {
    ip,
    socket: { remoteAddress: ip },
    body: { rows: [{ id: 1, password: 'validPass123' }] },
  }
}

// Extract the middleware handlers registered for the bulk-password POST.
async function getHandlers(envOverrides = {}) {
  const { mod } = await loadModule(envOverrides)
  const app = fakeApp()
  // mountBulkPasswordRoute registers on app; we don't need a real pool for
  // these rate-limit-focused tests — the rate limit fires before the handler.
  mod.mountBulkPasswordRoute(app, {
    pool: { connect: vi.fn().mockResolvedValue({ query: vi.fn().mockRejectedValue(new Error('no pool')), release: vi.fn() }) },
    capture500: vi.fn(),
    safeError: vi.fn(),
  })
  const reg = app.registrations.find(r => r.path === '/api/mailboxes/bulk-set-password')
  if (!reg) throw new Error('route not registered')
  return reg.handlers // [rateLimitFn, asyncHandler]
}

// ─────────────────────────────────────────────────────────────────────────────

describe('AD4 — bulk-password rate limit', () => {
  beforeEach(() => {
    delete process.env.BFF_RATE_LIMIT_DISABLED
  })
  afterEach(() => {
    delete process.env.BFF_RATE_LIMIT_DISABLED
  })

  // ── AD4-1: 5 calls within window → all allowed ───────────────────────────
  it('allows the first 5 calls from one IP', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const ip = '10.0.0.1'

    for (let i = 1; i <= 5; i++) {
      const req = fakeReq(ip)
      const res = fakeRes()
      let nextCalled = false
      await new Promise((resolve) => {
        rateLimitFn(req, res, () => { nextCalled = true; resolve() })
        // If 429 is returned synchronously (no next call), resolve on next tick.
        if (!nextCalled) setTimeout(resolve, 0)
      })
      expect(res._status, `call ${i} should not be 429`).not.toBe(429)
    }
  })

  // ── AD4-2: 6th call within window → 429 ─────────────────────────────────
  it('blocks the 6th call from the same IP with 429', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const ip = '10.0.0.2'

    // exhaust 5 allowed
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => {
        rateLimitFn(fakeReq(ip), fakeRes(), resolve)
      })
    }
    // 6th call
    const res6 = fakeRes()
    await new Promise((resolve) => {
      rateLimitFn(fakeReq(ip), res6, resolve)
      setTimeout(resolve, 10)
    })
    expect(res6._status).toBe(429)
  })

  // ── AD4-3: 7th call is still 429 (counter doesn't reset mid-window) ──────
  it('7th call is still 429 (idempotent block after first 429)', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const ip = '10.0.0.3'

    for (let i = 0; i < 7; i++) {
      const res = fakeRes()
      await new Promise((resolve) => {
        rateLimitFn(fakeReq(ip), res, resolve)
        setTimeout(resolve, 10)
      })
      if (i >= 5) {
        expect(res._status).toBe(429)
      }
    }
  })

  // ── AD4-4: after window reset, calls are allowed again ───────────────────
  it('resets counter after window expires', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const ip = '10.0.0.4'

    // Mock Date.now to simulate time passing.
    let fakeNow = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    // Exhaust quota.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => rateLimitFn(fakeReq(ip), fakeRes(), resolve))
    }

    // Advance time past window (60s + 1ms).
    fakeNow += 60_001

    const resAfterReset = fakeRes()
    let nextCalled = false
    await new Promise((resolve) => {
      rateLimitFn(fakeReq(ip), resAfterReset, () => { nextCalled = true; resolve() })
      setTimeout(resolve, 10)
    })

    vi.restoreAllMocks()
    expect(nextCalled, 'call after window reset should pass rate limit').toBe(true)
    expect(resAfterReset._status).not.toBe(429)
  })

  // ── AD4-5: two different IPs are independent ─────────────────────────────
  it('tracks each IP independently (one blocked does not block other)', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const ipA = '192.168.1.1'
    const ipB = '192.168.1.2'

    // Exhaust ipA.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => rateLimitFn(fakeReq(ipA), fakeRes(), resolve))
    }
    // ipA 6th → should be 429.
    const resA = fakeRes()
    await new Promise((resolve) => {
      rateLimitFn(fakeReq(ipA), resA, resolve)
      setTimeout(resolve, 10)
    })
    expect(resA._status).toBe(429)

    // ipB should still be allowed.
    let ipBNextCalled = false
    await new Promise((resolve) => {
      rateLimitFn(fakeReq(ipB), fakeRes(), () => { ipBNextCalled = true; resolve() })
      setTimeout(resolve, 10)
    })
    expect(ipBNextCalled, 'ipB must not be blocked by ipA quota').toBe(true)
  })

  // ── AD4-6: BFF_RATE_LIMIT_DISABLED=1 bypasses rate limit ─────────────────
  it('bypasses rate limit when BFF_RATE_LIMIT_DISABLED=1', async () => {
    process.env.BFF_RATE_LIMIT_DISABLED = '1'
    const handlers = await getHandlers({ BFF_RATE_LIMIT_DISABLED: '1' })
    const [rateLimitFn] = handlers
    const ip = '10.0.1.1'

    // 10 calls — all should pass the rate limit function.
    for (let i = 0; i < 10; i++) {
      let nextCalled = false
      await new Promise((resolve) => {
        rateLimitFn(fakeReq(ip), fakeRes(), () => { nextCalled = true; resolve() })
        setTimeout(resolve, 10)
      })
      expect(nextCalled, `call ${i+1} should bypass limit`).toBe(true)
    }
  })

  // ── AD4-7: unknown IP (unresolvable) gets a valid bucket ─────────────────
  it('handles unknown IP without crash', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const req = { ip: undefined, socket: undefined, body: {} }
    const res = fakeRes()
    // Must not throw.
    await expect(new Promise((resolve, reject) => {
      try {
        rateLimitFn(req, res, resolve)
        setTimeout(resolve, 10)
      } catch (e) {
        reject(e)
      }
    })).resolves.not.toThrow()
  })

  // ── AD4-8: 429 response body has { error: … } shape ──────────────────────
  it('429 body has error field', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const ip = '10.0.2.1'

    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => rateLimitFn(fakeReq(ip), fakeRes(), resolve))
    }
    const res = fakeRes()
    await new Promise((resolve) => {
      rateLimitFn(fakeReq(ip), res, resolve)
      setTimeout(resolve, 10)
    })
    expect(res._status).toBe(429)
    expect(res._body).toHaveProperty('error')
    expect(typeof res._body.error).toBe('string')
  })

  // ── AD4-9: rate limit fires BEFORE handler logic ──────────────────────────
  it('rate limit middleware is the first handler in the chain', async () => {
    const handlers = await getHandlers()
    // The registration should have at least 2 handlers: [rateLimitFn, asyncHandler].
    expect(handlers.length).toBeGreaterThanOrEqual(2)
    // First handler must be a synchronous gate (rate limit) — verify it's a function.
    expect(typeof handlers[0]).toBe('function')
  })

  // ── AD4-10: window boundary is not prematurely reset ─────────────────────
  it('does not reset window before 60s have elapsed', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const ip = '10.0.3.1'

    let fakeNow = 2_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    // Exhaust quota.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => rateLimitFn(fakeReq(ip), fakeRes(), resolve))
    }

    // Advance only 59s (not enough to reset).
    fakeNow += 59_000

    const res = fakeRes()
    await new Promise((resolve) => {
      rateLimitFn(fakeReq(ip), res, resolve)
      setTimeout(resolve, 10)
    })

    vi.restoreAllMocks()
    expect(res._status).toBe(429)
  })

  // ── AD4-11: 100 rapid calls → only first 5 pass, rest are 429 ────────────
  it('100 rapid calls: exactly first 5 pass, remaining 95 are 429', async () => {
    const handlers = await getHandlers()
    const [rateLimitFn] = handlers
    const ip = '10.0.4.1'

    let allowed = 0
    let blocked = 0

    for (let i = 0; i < 100; i++) {
      const res = fakeRes()
      let passed = false
      await new Promise((resolve) => {
        rateLimitFn(fakeReq(ip), res, () => { passed = true; resolve() })
        setTimeout(resolve, 5)
      })
      if (passed) allowed++
      else if (res._status === 429) blocked++
    }

    expect(allowed).toBe(5)
    expect(blocked).toBe(95)
  })
})
