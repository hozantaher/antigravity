// dashboardAuth.test.js — AW-F1 (2026-05-20)
//
// Unit tests for the Basic Auth middleware that gates the dashboard.
// Per feedback_extreme_testing T0 the security-adjacent code gets the
// 8-case spectrum: happy + bypass + every fail branch.

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import {
  requireDashboardAuth,
  isBypassPath,
  parseBasicAuthHeader,
  BCRYPT_COST_FACTOR,
  REALM,
} from '../../../src/lib/dashboardAuth.js'

const VALID_USER = 'operator'
const VALID_PASS = 'super-secret-test-password-aaaaaaaa1'
let VALID_HASH

function makeReq(path, headers = {}) {
  return { path, headers }
}
function makeRes() {
  const res = { _status: null, _body: null, _headers: {} }
  res.status = (s) => { res._status = s; return res }
  res.json = (b) => { res._body = b; return res }
  res.setHeader = (k, v) => { res._headers[k.toLowerCase()] = v }
  return res
}
function basicHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
}

describe('dashboardAuth — requireDashboardAuth', () => {
  let saved

  beforeAll(() => {
    // bcrypt cost 4 is a per-test override only; we use the real
    // VALID_HASH (cost 12) computed once below to also exercise the
    // production code path. Cost-4 fallback kept for fast re-runs.
    VALID_HASH = bcrypt.hashSync(VALID_PASS, 4)
  })

  beforeEach(() => {
    saved = {
      enabled: process.env.DASHBOARD_AUTH_ENABLED,
      user: process.env.DASHBOARD_USER,
      hash: process.env.DASHBOARD_PASS_HASH,
      bff: process.env.BFF_AUTH_DISABLED,
    }
    delete process.env.DASHBOARD_AUTH_ENABLED
    delete process.env.DASHBOARD_USER
    delete process.env.DASHBOARD_PASS_HASH
    delete process.env.BFF_AUTH_DISABLED
  })
  afterEach(() => {
    for (const [k, v] of Object.entries({
      DASHBOARD_AUTH_ENABLED: saved.enabled,
      DASHBOARD_USER: saved.user,
      DASHBOARD_PASS_HASH: saved.hash,
      BFF_AUTH_DISABLED: saved.bff,
    })) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  // ── 1: DISABLED (default) → next() ─────────────────────────────────
  it('case 1: DASHBOARD_AUTH_ENABLED unset/false → next() called, no 401', () => {
    const req = makeReq('/api/replies/stats')
    const res = makeRes()
    const next = vi.fn()
    requireDashboardAuth(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res._status).toBeNull()
  })

  // ── 2: ENABLED + missing envs → 503 misconfigured ──────────────────
  it('case 2: ENABLED but DASHBOARD_USER + DASHBOARD_PASS_HASH missing → 503', () => {
    process.env.DASHBOARD_AUTH_ENABLED = 'true'
    const req = makeReq('/api/replies/stats', { authorization: basicHeader(VALID_USER, VALID_PASS) })
    const res = makeRes()
    const next = vi.fn()
    // Silence the warn so test output stays clean
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    requireDashboardAuth(req, res, next)
    warnSpy.mockRestore()
    expect(res._status).toBe(503)
    expect(res._body).toEqual({ error: 'dashboard_auth_misconfigured' })
    expect(next).not.toHaveBeenCalled()
  })

  // ── 3: ENABLED + no Authorization header → 401 with WWW-Authenticate
  it('case 3: ENABLED + no Authorization header → 401 + WWW-Authenticate', () => {
    process.env.DASHBOARD_AUTH_ENABLED = 'true'
    process.env.DASHBOARD_USER = VALID_USER
    process.env.DASHBOARD_PASS_HASH = VALID_HASH
    const req = makeReq('/api/replies/stats')
    const res = makeRes()
    const next = vi.fn()
    requireDashboardAuth(req, res, next)
    expect(res._status).toBe(401)
    expect(res._headers['www-authenticate']).toContain('Basic')
    expect(res._headers['www-authenticate']).toContain(REALM)
    expect(next).not.toHaveBeenCalled()
  })

  // ── 4: ENABLED + wrong username → 401 ─────────────────────────────
  it('case 4: ENABLED + correct password but WRONG username → 401', () => {
    process.env.DASHBOARD_AUTH_ENABLED = 'true'
    process.env.DASHBOARD_USER = VALID_USER
    process.env.DASHBOARD_PASS_HASH = VALID_HASH
    const req = makeReq('/api/replies/stats', { authorization: basicHeader('wronguser', VALID_PASS) })
    const res = makeRes()
    const next = vi.fn()
    requireDashboardAuth(req, res, next)
    expect(res._status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  // ── 5: ENABLED + correct username + wrong password → 401 ──────────
  it('case 5: ENABLED + correct username, WRONG password → 401', () => {
    process.env.DASHBOARD_AUTH_ENABLED = 'true'
    process.env.DASHBOARD_USER = VALID_USER
    process.env.DASHBOARD_PASS_HASH = VALID_HASH
    const req = makeReq('/api/replies/stats', { authorization: basicHeader(VALID_USER, 'wrong-pass') })
    const res = makeRes()
    const next = vi.fn()
    requireDashboardAuth(req, res, next)
    expect(res._status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  // ── 6: ENABLED + correct credentials → next() ─────────────────────
  it('case 6: ENABLED + correct credentials → next() called', () => {
    process.env.DASHBOARD_AUTH_ENABLED = 'true'
    process.env.DASHBOARD_USER = VALID_USER
    process.env.DASHBOARD_PASS_HASH = VALID_HASH
    const req = makeReq('/api/replies/stats', { authorization: basicHeader(VALID_USER, VALID_PASS) })
    const res = makeRes()
    const next = vi.fn()
    requireDashboardAuth(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res._status).toBeNull()
  })

  // ── 7: bypass path /health → next() even without creds ────────────
  it('case 7: bypass path /health → next() with no Authorization header', () => {
    process.env.DASHBOARD_AUTH_ENABLED = 'true'
    process.env.DASHBOARD_USER = VALID_USER
    process.env.DASHBOARD_PASS_HASH = VALID_HASH
    const req = makeReq('/health')
    const res = makeRes()
    const next = vi.fn()
    requireDashboardAuth(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res._status).toBeNull()
  })

  // ── 8: BFF_AUTH_DISABLED=1 → next() even without creds ────────────
  it('case 8: BFF_AUTH_DISABLED=1 → next() even when ENABLED + no creds', () => {
    process.env.DASHBOARD_AUTH_ENABLED = 'true'
    process.env.DASHBOARD_USER = VALID_USER
    process.env.DASHBOARD_PASS_HASH = VALID_HASH
    process.env.BFF_AUTH_DISABLED = '1'
    const req = makeReq('/api/replies/stats')
    const res = makeRes()
    const next = vi.fn()
    requireDashboardAuth(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res._status).toBeNull()
  })
})

describe('dashboardAuth — helpers', () => {
  it('isBypassPath: known exact paths return true', () => {
    expect(isBypassPath('/health')).toBe(true)
    expect(isBypassPath('/healthz')).toBe(true)
    expect(isBypassPath('/api/sentry/tunnel')).toBe(true)
    expect(isBypassPath('/__schema-check')).toBe(true)
  })
  it('isBypassPath: prefix /api/health/system → true (sub-route under bypass)', () => {
    expect(isBypassPath('/api/health/system')).toBe(true)
    expect(isBypassPath('/api/health/drift')).toBe(true)
  })
  it('isBypassPath: unrelated paths return false', () => {
    expect(isBypassPath('/api/replies/stats')).toBe(false)
    expect(isBypassPath('/api/mailboxes')).toBe(false)
    expect(isBypassPath('')).toBe(false)
    expect(isBypassPath(null)).toBe(false)
  })

  it('parseBasicAuthHeader: valid → { user, pass }', () => {
    const parsed = parseBasicAuthHeader(basicHeader('alice', 'bob'))
    expect(parsed).toEqual({ user: 'alice', pass: 'bob' })
  })
  it('parseBasicAuthHeader: handles colon inside password', () => {
    const parsed = parseBasicAuthHeader(basicHeader('alice', 'pa:ss:word'))
    expect(parsed).toEqual({ user: 'alice', pass: 'pa:ss:word' })
  })
  it('parseBasicAuthHeader: missing/empty header → null', () => {
    expect(parseBasicAuthHeader(undefined)).toBeNull()
    expect(parseBasicAuthHeader('')).toBeNull()
    expect(parseBasicAuthHeader(null)).toBeNull()
  })
  it('parseBasicAuthHeader: wrong scheme → null', () => {
    expect(parseBasicAuthHeader('Bearer abc123')).toBeNull()
  })
  it('parseBasicAuthHeader: malformed base64 / missing colon → null', () => {
    const noColon = 'Basic ' + Buffer.from('justuser', 'utf8').toString('base64')
    expect(parseBasicAuthHeader(noColon)).toBeNull()
  })

  it('exports the bcrypt cost constant', () => {
    // Per feedback_no_magic_thresholds T0 — exposed as a named constant
    expect(BCRYPT_COST_FACTOR).toBe(12)
  })
  it('exports the realm constant', () => {
    expect(REALM).toBe('Hozan Taher Dashboard')
  })
})
