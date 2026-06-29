import { afterEach, describe, expect, it } from 'vitest'
import { enforceRateLimit, ipFromEvent } from '~/server/utils/rateLimit'
import { makeEvent } from '../setup/server'

// ipFromEvent reads the raw node request, which makeEvent doesn't model — build it inline.
const reqEvent = (xff?: string | string[], remoteAddress = '9.9.9.9') =>
  ({
    node: {
      req: {
        socket: { remoteAddress },
        headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
      },
    },
  }) as never

describe('ipFromEvent', () => {
  const orig = process.env.RATE_LIMIT_TRUSTED_HOPS
  afterEach(() => {
    if (orig === undefined) delete process.env.RATE_LIMIT_TRUSTED_HOPS
    else process.env.RATE_LIMIT_TRUSTED_HOPS = orig
  })

  it('takes the client IP one hop from the end (default 1 trusted hop)', () => {
    delete process.env.RATE_LIMIT_TRUSTED_HOPS
    expect(ipFromEvent(reqEvent('1.1.1.1, 2.2.2.2'))).toBe('2.2.2.2')
  })

  it('falls back to the socket peer when there is no XFF', () => {
    delete process.env.RATE_LIMIT_TRUSTED_HOPS
    expect(ipFromEvent(reqEvent(undefined, '5.5.5.5'))).toBe('5.5.5.5')
  })

  it('falls back to the socket peer when the candidate hop is not a valid IP', () => {
    delete process.env.RATE_LIMIT_TRUSTED_HOPS
    expect(ipFromEvent(reqEvent('garbage', '5.5.5.5'))).toBe('5.5.5.5')
  })

  it('ignores XFF entirely with 0 trusted hops', () => {
    process.env.RATE_LIMIT_TRUSTED_HOPS = '0'
    expect(ipFromEvent(reqEvent('1.1.1.1, 2.2.2.2', '5.5.5.5'))).toBe('5.5.5.5')
  })

  it('honours a configured hop count > 1', () => {
    process.env.RATE_LIMIT_TRUSTED_HOPS = '2'
    expect(ipFromEvent(reqEvent('1.1.1.1, 2.2.2.2, 3.3.3.3'))).toBe('2.2.2.2')
  })
})

describe('enforceRateLimit', () => {
  it('allows requests up to the limit then throws 429', () => {
    const event = makeEvent()
    const opts = { bucket: 'b1', limit: 2, windowMs: 60_000, key: 'k1' }
    expect(() => enforceRateLimit(event as never, opts)).not.toThrow()
    expect(() => enforceRateLimit(event as never, opts)).not.toThrow()
    expect(() => enforceRateLimit(event as never, opts)).toThrowError(expect.objectContaining({ statusCode: 429 }))
  })

  it('keys separately per bucket', () => {
    const event = makeEvent()
    expect(() => enforceRateLimit(event as never, { bucket: 'b2', limit: 1, windowMs: 60_000, key: 'k' })).not.toThrow()
    expect(() => enforceRateLimit(event as never, { bucket: 'b3', limit: 1, windowMs: 60_000, key: 'k' })).not.toThrow()
  })
})
