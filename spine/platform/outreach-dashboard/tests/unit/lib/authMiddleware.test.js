import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createAuthMiddleware, AUTH_EXEMPT } from '../../../src/lib/authMiddleware.js'

function makeReq(path, key = undefined) {
  return {
    path,
    headers: key !== undefined ? { 'x-api-key': key } : {},
  }
}
function makeRes() {
  const res = { _status: null, _body: null }
  res.status = (s) => { res._status = s; return res }
  res.json   = (b) => { res._body  = b; return res }
  return res
}

describe('createAuthMiddleware', () => {
  const VALID_KEY = 'test-secret-key'
  let mw
  let savedEnv
  let savedAuthDisabled

  beforeEach(() => {
    savedEnv = process.env.OUTREACH_API_KEY
    process.env.OUTREACH_API_KEY = VALID_KEY
    // Under TEST_SCOPE=all/contract the vitest config sets
    // BFF_AUTH_DISABLED=1 globally so route handlers don't 401 across
    // contract suites. Tests of the auth middleware itself must run with
    // it cleared, otherwise every request short-circuits via next().
    savedAuthDisabled = process.env.BFF_AUTH_DISABLED
    delete process.env.BFF_AUTH_DISABLED
    mw = createAuthMiddleware()
  })
  afterEach(() => {
    process.env.OUTREACH_API_KEY = savedEnv
    if (savedAuthDisabled === undefined) delete process.env.BFF_AUTH_DISABLED
    else process.env.BFF_AUTH_DISABLED = savedAuthDisabled
  })

  // T-0349: no key → 401
  it('rejects request without x-api-key', () => {
    const req  = makeReq('/api/mailboxes')
    const res  = makeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(res._status).toBe(401)
    expect(res._body).toMatchObject({ error: expect.any(String) })
    expect(next).not.toHaveBeenCalled()
  })

  // T-0350: valid key → passes through
  it('calls next() for request with valid x-api-key', () => {
    const req  = makeReq('/api/mailboxes', VALID_KEY)
    const res  = makeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res._status).toBeNull()
  })

  // T-0351: wrong key → 401
  it('rejects wrong key', () => {
    const req  = makeReq('/api/mailboxes', 'wrong-key')
    const res  = makeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(res._status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  // T-0352: exempt paths bypass auth
  it.each(AUTH_EXEMPT)('exempt path %s passes without key', (path) => {
    const req  = makeReq(path)
    const res  = makeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res._status).toBeNull()
  })

  // T-0351: reads key from env at call time
  it('uses OUTREACH_API_KEY from env', () => {
    process.env.OUTREACH_API_KEY = 'dynamic-key'
    mw = createAuthMiddleware()
    const req  = makeReq('/api/mailboxes', 'dynamic-key')
    const res  = makeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  // T-0349: no env key configured → deny all (fail-safe)
  it('rejects all when OUTREACH_API_KEY not set', () => {
    delete process.env.OUTREACH_API_KEY
    mw = createAuthMiddleware()
    const req  = makeReq('/api/mailboxes', 'any-key')
    const res  = makeRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(res._status).toBe(401)
  })
})
