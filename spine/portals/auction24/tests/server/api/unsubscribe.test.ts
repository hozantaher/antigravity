import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import unsubscribeHandler from '~/server/api/newsletter/unsubscribe.get'
import { setNewsletterEnabled } from '~/server/repos/newsletterRepo'
import { verifyUnsubscribeToken } from '~/server/utils/newsletterBuilder'

vi.mock('~/server/repos/newsletterRepo', () => ({ setNewsletterEnabled: vi.fn() }))
vi.mock('~/server/utils/newsletterBuilder', () => ({ verifyUnsubscribeToken: vi.fn() }))

const g = globalThis as unknown as { useRuntimeConfig: ReturnType<typeof vi.fn> }

const withSecret = (secret: string | undefined) =>
  g.useRuntimeConfig.mockReturnValue({ public: {}, internalApiSecret: secret })

beforeEach(() => {
  vi.clearAllMocks()
  withSecret('hmac-secret')
})

describe('GET /api/newsletter/unsubscribe', () => {
  it('returns 503 when the internal API secret is not configured', async () => {
    withSecret(undefined)
    await expect(unsubscribeHandler(makeEvent({ query: { token: 't' } }) as never)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'Unsubscribe not configured',
    })
    expect(verifyUnsubscribeToken).not.toHaveBeenCalled()
    expect(setNewsletterEnabled).not.toHaveBeenCalled()
  })

  it('returns 400 when the token query param is not a string', async () => {
    await expect(unsubscribeHandler(makeEvent({ query: { token: ['a', 'b'] } }) as never)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'Invalid token',
    })
    expect(verifyUnsubscribeToken).not.toHaveBeenCalled()
    expect(setNewsletterEnabled).not.toHaveBeenCalled()
  })

  it('returns 400 when the token is missing', async () => {
    await expect(unsubscribeHandler(makeEvent() as never)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'Invalid token',
    })
    expect(verifyUnsubscribeToken).not.toHaveBeenCalled()
  })

  it('returns 400 when the token fails HMAC verification', async () => {
    vi.mocked(verifyUnsubscribeToken).mockReturnValue(null)
    await expect(unsubscribeHandler(makeEvent({ query: { token: 'bad-token' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'Invalid token',
    })
    expect(verifyUnsubscribeToken).toHaveBeenCalledWith('bad-token')
    expect(setNewsletterEnabled).not.toHaveBeenCalled()
  })

  it('disables the newsletter and returns the confirmation HTML for a valid token', async () => {
    vi.mocked(verifyUnsubscribeToken).mockReturnValue('user-42')
    vi.mocked(setNewsletterEnabled).mockResolvedValue(undefined as never)

    const event = makeEvent({ query: { token: 'good-token' } })
    const html = await unsubscribeHandler(event as never)

    expect(verifyUnsubscribeToken).toHaveBeenCalledWith('good-token')
    expect(setNewsletterEnabled).toHaveBeenCalledWith('user-42', false)
    expect((event.context as unknown as { resHeaders: Record<string, string> }).resHeaders['content-type']).toBe(
      'text/html; charset=utf-8',
    )
    expect(html).toContain('Unsubscribed')
    expect(html).toContain('<!doctype html>')
  })

  it('propagates a rejection from setNewsletterEnabled', async () => {
    vi.mocked(verifyUnsubscribeToken).mockReturnValue('user-7')
    vi.mocked(setNewsletterEnabled).mockRejectedValue(new Error('db down'))

    await expect(unsubscribeHandler(makeEvent({ query: { token: 'good-token' } }) as never)).rejects.toThrow('db down')
  })
})
