import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthHeader } from '~/features/platform/auth-account/logic/authHeader'

const spies = vi.hoisted(() => ({ getCachedFirebaseAuth: vi.fn() }))

vi.mock('~/features/platform/auth-account/logic/firebaseClient', () => ({
  getCachedFirebaseAuth: spies.getCachedFirebaseAuth,
}))

beforeEach(() => vi.clearAllMocks())

describe('getAuthHeader', () => {
  it('returns an empty header when firebase auth never loaded (anon)', async () => {
    spies.getCachedFirebaseAuth.mockReturnValue(null)
    expect(await getAuthHeader()).toEqual({})
  })

  it('returns an empty header when auth exists but there is no current user', async () => {
    spies.getCachedFirebaseAuth.mockReturnValue({ currentUser: null } as never)
    expect(await getAuthHeader()).toEqual({})
  })

  it('returns a Bearer header with a fresh id token for a logged-in user', async () => {
    const getIdToken = vi.fn().mockResolvedValue('tok-123')
    spies.getCachedFirebaseAuth.mockReturnValue({ currentUser: { getIdToken } } as never)
    expect(await getAuthHeader()).toEqual({ Authorization: 'Bearer tok-123' })
    expect(getIdToken).toHaveBeenCalledTimes(1)
  })
})
