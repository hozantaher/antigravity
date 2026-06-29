import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent, setSessionUser } from '../../setup/server'

import mePutHandler from '~/server/api/me.put'
import toggleHandler from '~/server/api/favorites/toggle.post'
import { toggleFavorite, updateUserProfile } from '~/server/repos/userRepo'

vi.mock('~/server/repos/userRepo', () => ({ updateUserProfile: vi.fn(), toggleFavorite: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  setSessionUser({ id: 'u1' })
})

describe('PUT /api/me', () => {
  it('persists the whitelisted profile fields', async () => {
    vi.mocked(updateUserProfile).mockResolvedValue({ id: 'u1', fullName: 'New' } as never)
    const res = await mePutHandler(makeEvent({ body: { fullName: 'New' } }) as never)
    expect(updateUserProfile).toHaveBeenCalledWith('u1', { fullName: 'New' })
    expect(res).toMatchObject({ fullName: 'New' })
  })

  it('404s when the user row is gone', async () => {
    vi.mocked(updateUserProfile).mockResolvedValue(undefined as never)
    await expect(mePutHandler(makeEvent({ body: {} }) as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('defaults a null body to an empty patch', async () => {
    vi.mocked(updateUserProfile).mockResolvedValue({ id: 'u1' } as never)
    await mePutHandler(makeEvent({ body: null }) as never)
    expect(updateUserProfile).toHaveBeenCalledWith('u1', {})
  })
})

describe('POST /api/favorites/toggle', () => {
  it('toggles and returns the new favorite ids', async () => {
    vi.mocked(toggleFavorite).mockResolvedValue(['a'] as never)
    const res = await toggleHandler(makeEvent({ body: { id: 'a' } }) as never)
    expect(toggleFavorite).toHaveBeenCalledWith('u1', 'a')
    expect(res).toEqual({ favoriteIds: ['a'] })
  })

  it('400s when the item id is missing', async () => {
    await expect(toggleHandler(makeEvent({ body: {} }) as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(toggleFavorite).not.toHaveBeenCalled()
  })

  it('treats an unreadable body as missing id (readBody rejects)', async () => {
    // Force readBody(event) to reject so the .catch(() => null) fallback runs,
    // then body?.id is undefined and the handler 400s.
    const base = makeEvent() as unknown as { context: Record<string, unknown> }
    Object.defineProperty(base.context, 'body', {
      get() {
        throw new Error('boom')
      },
    })
    await expect(toggleHandler(base as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(toggleFavorite).not.toHaveBeenCalled()
  })
})
