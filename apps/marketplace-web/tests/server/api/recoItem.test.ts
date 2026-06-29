import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent, setSessionUser } from '../../setup/server'

import handler from '~/server/api/recommendations/item/[id].get'
import { recommendForItem } from '~/server/utils/recommendation/serve'

vi.mock('~/server/utils/recommendation/serve', () => ({ recommendForItem: vi.fn() }))

const VID_COOKIE = 'a24_vid'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(recommendForItem).mockResolvedValue([] as never)
})

describe('GET /api/recommendations/item/:id', () => {
  it('throws 400 when the anchor id is missing', async () => {
    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(recommendForItem).not.toHaveBeenCalled()
  })

  it('forwards vid cookie, session user id and default limit/locale', async () => {
    setSessionUser({ id: 'u1' })
    const result = [{ id: 'i2' }]
    vi.mocked(recommendForItem).mockResolvedValue(result as never)

    const out = await handler(makeEvent({ params: { id: 'i1' }, cookies: { [VID_COOKIE]: 'v-abc' } }) as never)

    expect(out).toBe(result)
    expect(recommendForItem).toHaveBeenCalledWith({
      anchorId: 'i1',
      vid: 'v-abc',
      userId: 'u1',
      locale: 'cz',
      limit: 12,
    })
  })

  it('passes undefined vid and userId when cookie and session are absent', async () => {
    setSessionUser(undefined)

    await handler(makeEvent({ params: { id: 'i9' } }) as never)

    expect(recommendForItem).toHaveBeenCalledWith({
      anchorId: 'i9',
      vid: undefined,
      userId: undefined,
      locale: 'cz',
      limit: 12,
    })
  })

  it('clamps the requested limit and resolves locale from Accept-Language', async () => {
    setSessionUser({ id: 'u2' })

    await handler(
      makeEvent({
        params: { id: 'i3' },
        query: { limit: '999' },
        headers: { 'accept-language': 'de-DE,de;q=0.9' },
      }) as never,
    )

    expect(recommendForItem).toHaveBeenCalledWith({
      anchorId: 'i3',
      vid: undefined,
      userId: 'u2',
      locale: 'de',
      limit: 24,
    })
  })
})
