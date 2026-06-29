import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent, setSessionUser } from '../../setup/server'

import homeHandler from '~/server/api/recommendations/home.get'
import { recommendForHome } from '~/server/utils/recommendation/serve'

vi.mock('~/server/utils/recommendation/serve', () => ({ recommendForHome: vi.fn() }))

const getSessionUserMock = () => (globalThis as unknown as { getSessionUser: ReturnType<typeof vi.fn> }).getSessionUser

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(recommendForHome).mockResolvedValue([])
})

describe('GET /api/recommendations/home', () => {
  it('passes vid cookie, user id and resolved locale through to recommendForHome', async () => {
    setSessionUser({ id: 'user-7' })
    const result = await homeHandler(
      makeEvent({
        cookies: { a24_vid: 'visitor-9' },
        headers: { 'accept-language': 'de-DE,de;q=0.9' },
        query: { limit: '8' },
      }) as never,
    )
    expect(recommendForHome).toHaveBeenCalledWith({ vid: 'visitor-9', userId: 'user-7', locale: 'de', limit: 8 })
    expect(result).toEqual([])
  })

  it('degrades to anonymous when no cookie and no session user', async () => {
    getSessionUserMock().mockResolvedValue(undefined)
    await homeHandler(makeEvent() as never)
    expect(recommendForHome).toHaveBeenCalledWith({
      vid: undefined,
      userId: undefined,
      locale: 'cz',
      limit: 12,
    })
  })

  it('treats a null session user as anonymous (optional-chain on id)', async () => {
    getSessionUserMock().mockResolvedValue(null)
    await homeHandler(makeEvent({ cookies: { a24_vid: 'v1' } }) as never)
    expect(recommendForHome).toHaveBeenCalledWith(expect.objectContaining({ vid: 'v1', userId: undefined }))
  })

  it('clamps an over-max limit down to servingMaxN (24)', async () => {
    getSessionUserMock().mockResolvedValue(undefined)
    await homeHandler(makeEvent({ query: { limit: '999' } }) as never)
    expect(recommendForHome).toHaveBeenCalledWith(expect.objectContaining({ limit: 24 }))
  })

  it('clamps a below-min limit up to 4', async () => {
    getSessionUserMock().mockResolvedValue(undefined)
    await homeHandler(makeEvent({ query: { limit: '1' } }) as never)
    expect(recommendForHome).toHaveBeenCalledWith(expect.objectContaining({ limit: 4 }))
  })

  it('uses the default limit (12) when the query value is not finite', async () => {
    getSessionUserMock().mockResolvedValue(undefined)
    await homeHandler(makeEvent({ query: { limit: 'abc' } }) as never)
    expect(recommendForHome).toHaveBeenCalledWith(expect.objectContaining({ limit: 12 }))
  })

  it('returns whatever recommendForHome resolves with', async () => {
    getSessionUserMock().mockResolvedValue(undefined)
    const items = [{ id: 'a' }, { id: 'b' }]
    vi.mocked(recommendForHome).mockResolvedValue(items as never)
    await expect(homeHandler(makeEvent() as never)).resolves.toBe(items)
  })
})
