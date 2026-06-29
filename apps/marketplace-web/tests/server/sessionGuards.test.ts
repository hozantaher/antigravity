import { afterEach, describe, expect, it, vi } from 'vitest'
import { requireCronSecret } from '~/server/utils/session'
import { makeEvent } from '../setup/server'

const withCronSecret = (secret?: string) => {
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ cronSecret: secret })
}

describe('requireCronSecret', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('passes a request bearing the configured secret', () => {
    withCronSecret('top-secret')
    const event = makeEvent({ headers: { authorization: 'Bearer top-secret' } })
    expect(() => requireCronSecret(event as never)).not.toThrow()
  })

  it('rejects a mismatched secret with 401', () => {
    withCronSecret('top-secret')
    const event = makeEvent({ headers: { authorization: 'Bearer wrong' } })
    expect(() => requireCronSecret(event as never)).toThrowError(expect.objectContaining({ statusCode: 401 }))
  })

  it('rejects a missing Authorization header with 401', () => {
    withCronSecret('top-secret')
    expect(() => requireCronSecret(makeEvent() as never)).toThrowError(expect.objectContaining({ statusCode: 401 }))
  })

  it('returns 503 when the cron secret is not configured', () => {
    withCronSecret(undefined)
    const event = makeEvent({ headers: { authorization: 'Bearer anything' } })
    expect(() => requireCronSecret(event as never)).toThrowError(expect.objectContaining({ statusCode: 503 }))
  })
})
