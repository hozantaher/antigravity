import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOobActionUrl, failEmailAction } from '~/server/utils/authEmail'
import { makeEvent } from '../setup/server'

const g = globalThis as Record<string, unknown>

beforeEach(() => {
  g.useRuntimeConfig = () => ({ public: { baseUrl: 'https://app.test' } })
})
afterEach(() => vi.restoreAllMocks())

describe('buildOobActionUrl', () => {
  it('rebuilds the action URL on our domain from the Firebase oobCode', () => {
    const url = buildOobActionUrl(
      makeEvent() as never,
      'https://fb/__/auth?oobCode=ABC123&mode=resetPassword',
      '/auth/reset',
    )
    expect(url).toBe('https://app.test/auth/reset?oobCode=ABC123')
  })

  it('falls back to the request origin when baseUrl is unset', () => {
    g.useRuntimeConfig = () => ({ public: {} })
    const url = buildOobActionUrl(
      makeEvent({ url: 'https://req.host/x' }) as never,
      'https://fb/?oobCode=Z',
      '/auth/verify',
    )
    expect(url).toBe('https://req.host/auth/verify?oobCode=Z')
  })

  it('throws when the Firebase link carries no oobCode', () => {
    expect(() => buildOobActionUrl(makeEvent() as never, 'https://fb/no-code', '/auth/reset')).toThrow()
  })
})

describe('failEmailAction', () => {
  it('logs the cause and throws a generic 502', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => failEmailAction(new Error('boom'), 'area', 'Failed')).toThrowError(
      expect.objectContaining({ statusCode: 502 }),
    )
    spy.mockRestore()
  })
})
