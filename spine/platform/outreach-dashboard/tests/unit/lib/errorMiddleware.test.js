import { describe, it, expect, vi } from 'vitest'
import { createErrorMiddleware } from '../../../src/lib/errorMiddleware.js'

function makeRes() {
  const res = { _status: null, _body: null, _headers: {} }
  res.status  = (s)    => { res._status = s; return res }
  res.json    = (b)    => { res._body   = b; return res }
  res.setHeader = (k, v) => { res._headers[k] = v }
  return res
}

describe('createErrorMiddleware', () => {
  const mw = createErrorMiddleware()

  // T-0357: generic Error → 500 + { error }
  it('returns 500 for unhandled Error', () => {
    const err = new Error('boom')
    const res = makeRes()
    const next = vi.fn()
    mw(err, {}, res, next)
    expect(res._status).toBe(500)
    expect(res._body).toMatchObject({ error: 'internal server error' })
    expect(next).not.toHaveBeenCalled()
  })

  // T-0358: error with .status → uses that status
  it('uses err.status when present', () => {
    const err = Object.assign(new Error('bad input'), { status: 422 })
    const res = makeRes()
    mw(err, {}, res, vi.fn())
    expect(res._status).toBe(422)
    expect(res._body).toMatchObject({ error: 'bad input' })
  })

  // T-0359: err.statusCode also accepted
  it('uses err.statusCode when present', () => {
    const err = Object.assign(new Error('gone'), { statusCode: 410 })
    const res = makeRes()
    mw(err, {}, res, vi.fn())
    expect(res._status).toBe(410)
  })

  // T-0360: string error
  it('handles thrown string', () => {
    const res = makeRes()
    mw('something went wrong', {}, res, vi.fn())
    expect(res._status).toBe(500)
    expect(res._body).toMatchObject({ error: 'internal server error' })
  })

  // T-0361: no leak of stack trace in body
  it('never leaks stack trace', () => {
    const err = new Error('secret details in stack')
    const res = makeRes()
    mw(err, {}, res, vi.fn())
    expect(JSON.stringify(res._body)).not.toContain('secret details')
    expect(JSON.stringify(res._body)).not.toContain('stack')
  })

  // T-0362: responds with JSON content-type
  it('sets content-type application/json via res.json', () => {
    // res.json being called is sufficient — express sets the header
    const err = new Error('x')
    const res = makeRes()
    mw(err, {}, res, vi.fn())
    expect(res._body).toBeTruthy()
  })
})
