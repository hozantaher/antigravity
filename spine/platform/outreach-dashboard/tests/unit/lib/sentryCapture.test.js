import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const withScopeFn = vi.fn()
const addBreadcrumbFn = vi.fn()
vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: withScopeFn,
  addBreadcrumb: addBreadcrumbFn,
}))

const { captureException } = await import('@sentry/node')

// RED: these imports don't exist yet — tests will fail until sentryCapture.js is created
const { capture500, captureAndRespond, getFingerprint } = await import('../../../src/lib/sentryCapture.js')

function mockRes() {
  const res = { _status: null, _body: null }
  res.status = (code) => { res._status = code; return res }
  res.json = (body) => { res._body = body; return res }
  return res
}

beforeEach(() => vi.clearAllMocks())

describe('capture500', () => {
  it('calls Sentry.captureException with the error', () => {
    const err = new Error('db timeout')
    const res = mockRes()
    // Set up withScope to call the callback
    withScopeFn.mockImplementation((fn) => {
      fn({ setFingerprint: vi.fn(), setTag: vi.fn() })
    })
    capture500(res, err, () => 'internal error')
    expect(captureException).toHaveBeenCalledWith(err)
  })

  it('returns 500 JSON with sanitized message', () => {
    const res = mockRes()
    withScopeFn.mockImplementation((fn) => {
      fn({ setFingerprint: vi.fn(), setTag: vi.fn() })
    })
    capture500(res, new Error('db timeout'), () => 'internal error')
    expect(res._status).toBe(500)
    expect(res._body).toEqual({ error: 'internal error' })
  })

  it('captures non-Error objects by wrapping them in Error', () => {
    const res = mockRes()
    withScopeFn.mockImplementation((fn) => {
      fn({ setFingerprint: vi.fn(), setTag: vi.fn() })
    })
    const notAnError = { status: 404, message: 'not found' }
    capture500(res, notAnError, (e) => e.message)
    // Should still call captureException (wrapped)
    expect(captureException).toHaveBeenCalledWith(expect.any(Error))
    expect(res._status).toBe(500)
  })

  it('uses custom status code when provided', () => {
    const res = mockRes()
    withScopeFn.mockImplementation((fn) => {
      fn({ setFingerprint: vi.fn(), setTag: vi.fn() })
    })
    capture500(res, new Error('gone'), () => 'gone', 503)
    expect(res._status).toBe(503)
  })

  it('still returns 500 when Sentry throws', () => {
    withScopeFn.mockImplementationOnce(() => { throw new Error('sentry down') })
    const res = mockRes()
    expect(() => capture500(res, new Error('orig'), () => 'err')).not.toThrow()
    expect(res._status).toBe(500)
  })
})

describe('captureAndRespond — alias', () => {
  it('is the same function as capture500', () => {
    expect(captureAndRespond).toBe(capture500)
  })
})

describe('getFingerprint', () => {
  it('DB error with code → ["db-error", code]', () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' })
    expect(getFingerprint(err)).toEqual(['db-error', '23505'])
  })

  it('401 → ["auth-error"]', () => {
    const err = Object.assign(new Error('unauthorized'), { status: 401 })
    expect(getFingerprint(err)).toEqual(['auth-error'])
  })

  it('403 → ["auth-error"]', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 })
    expect(getFingerprint(err)).toEqual(['auth-error'])
  })

  it('404 → ["not-found"]', () => {
    const err = Object.assign(new Error('record not found'), { status: 404 })
    expect(getFingerprint(err)).toEqual(['not-found'])
  })

  it('null → ["generic-error"]', () => {
    expect(getFingerprint(null)).toEqual(['generic-error'])
  })

  it('undefined → ["generic-error"]', () => {
    expect(getFingerprint(undefined)).toEqual(['generic-error'])
  })

  it('plain Error (no code/status) → ["{{ default }}"]', () => {
    expect(getFingerprint(new Error('something unexpected'))).toEqual(['{{ default }}'])
  })

  it('never throws for any input — property test over 20 diverse inputs', () => {
    const inputs = [
      null, undefined, 0, '', false, true, [], {}, Symbol('x'),
      new TypeError('type'), new RangeError('range'),
      { code: '' }, { code: null }, { status: NaN }, { status: -1 },
      { message: null }, { message: 123 }, { code: '23505', status: 403 },
      new Error(), Object.create(null),
    ]
    for (const inp of inputs) {
      expect(() => getFingerprint(inp)).not.toThrow()
      const fp = getFingerprint(inp)
      expect(Array.isArray(fp)).toBe(true)
      expect(fp.length).toBeGreaterThan(0)
    }
  })

  it('property: output always array with ≥1 string element', () => {
    const inputs = [
      null, undefined, '', 0, false, {}, [], new Error(),
      { code: '23505' }, { status: 401 }, { status: 404 },
      { message: 'auth failed' }, { message: 'not found' },
    ]
    for (const i of inputs) {
      const fp = getFingerprint(i)
      expect(Array.isArray(fp)).toBe(true)
      expect(fp.length).toBeGreaterThan(0)
      expect(typeof fp[0]).toBe('string')
    }
  })
})

// ── addAuthBreadcrumb MONKEY tests ────────────────────────────────────────────
//
// addAuthBreadcrumb lives in sentry.server.js but is tested here alongside the
// other Sentry-capture utilities (same mock surface, same unit isolation).

const { addAuthBreadcrumb } = await import('../../../sentry.server.js')

describe('addAuthBreadcrumb MONKEY', () => {
  const origDsn = process.env.SENTRY_DSN_BFF

  beforeEach(() => {
    addBreadcrumbFn.mockClear()
    process.env.SENTRY_DSN_BFF = 'https://test@sentry.io/0'
  })

  afterEach(() => {
    if (origDsn != null) {
      process.env.SENTRY_DSN_BFF = origDsn
    } else {
      delete process.env.SENTRY_DSN_BFF
    }
  })

  it('null reason → empty string breadcrumb, no crash', () => {
    expect(() => addAuthBreadcrumb(null)).not.toThrow()
    expect(addBreadcrumbFn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'auth', message: '' })
    )
  })

  it('number reason → converted to string, no crash', () => {
    expect(() => addAuthBreadcrumb(42)).not.toThrow()
    expect(addBreadcrumbFn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'auth', message: '42' })
    )
  })

  it('10k char reason → no crash', () => {
    const huge = 'x'.repeat(10_000)
    expect(() => addAuthBreadcrumb(huge)).not.toThrow()
    expect(addBreadcrumbFn).toHaveBeenCalled()
  })

  it('object reason → String() converted, no crash', () => {
    expect(() => addAuthBreadcrumb({ nested: 'object' })).not.toThrow()
    expect(addBreadcrumbFn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'auth', message: expect.any(String) })
    )
  })

  it('undefined reason → empty string breadcrumb, no crash', () => {
    expect(() => addAuthBreadcrumb(undefined)).not.toThrow()
    expect(addBreadcrumbFn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'auth', message: '' })
    )
  })

  it('empty string reason → breadcrumb with empty message, no crash', () => {
    expect(() => addAuthBreadcrumb('')).not.toThrow()
    expect(addBreadcrumbFn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'auth', message: '' })
    )
  })

  it('throws from Sentry → no propagation to caller', () => {
    addBreadcrumbFn.mockImplementationOnce(() => { throw new Error('sentry dead') })
    expect(() => addAuthBreadcrumb('reason')).not.toThrow()
  })

  it('works without DSN (no-op) — no breadcrumb emitted', () => {
    delete process.env.SENTRY_DSN_BFF
    addBreadcrumbFn.mockClear()
    expect(() => addAuthBreadcrumb('test reason')).not.toThrow()
    expect(addBreadcrumbFn).not.toHaveBeenCalled()
  })

  it('boolean false reason → string "false", no crash', () => {
    expect(() => addAuthBreadcrumb(false)).not.toThrow()
    expect(addBreadcrumbFn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'auth', message: 'false' })
    )
  })

  it('array reason → String() representation, no crash', () => {
    expect(() => addAuthBreadcrumb(['a', 'b'])).not.toThrow()
    expect(addBreadcrumbFn).toHaveBeenCalled()
  })

  it('breadcrumb always has level=warning when DSN set', () => {
    addAuthBreadcrumb('some failure')
    expect(addBreadcrumbFn).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning' })
    )
  })
})
