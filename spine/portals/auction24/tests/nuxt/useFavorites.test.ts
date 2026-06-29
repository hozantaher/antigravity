import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

import useFavorites from '~/features/demand/favorites/logic/useFavorites'

// useUser + useLocalePath are project/i18n composables and navigateTo is a non-bootstrap app util,
// so all three are safe to mock (unlike core useRuntimeConfig/useRouter). Shared state is mutated
// per test. localePath is stubbed to localize the path deterministically — the de-localized routes
// fix (commit 907a406) routes the anon redirect through localePath('/sign') instead of a bare path.
const { nav, userState, localePath } = vi.hoisted(() => ({
  nav: vi.fn(),
  localePath: vi.fn((p: string) => `/en${p}`),
  userState: { isLogged: { value: false }, user: { value: null as null | { favoriteIds: string[] } } },
}))
mockNuxtImport('navigateTo', () => nav)
mockNuxtImport('useUser', () => () => userState)
mockNuxtImport('useLocalePath', () => () => localePath)

beforeEach(() => {
  vi.clearAllMocks()
  localePath.mockImplementation((p: string) => `/en${p}`)
  userState.isLogged.value = false
  userState.user.value = null
})

describe('useFavorites', () => {
  it('redirects anonymous users through localePath instead of calling the API', async () => {
    const f = vi.fn()
    vi.stubGlobal('$fetch', f)
    await useFavorites().toggleFavorite('i1')
    expect(localePath).toHaveBeenCalledWith('/sign')
    expect(nav).toHaveBeenCalledWith('/en/sign')
    expect(f).not.toHaveBeenCalled()
  })

  it('toggles and syncs the user favorites (add) when logged in', async () => {
    userState.isLogged.value = true
    userState.user.value = { favoriteIds: [] }
    const f = vi.fn().mockResolvedValue({ favoriteIds: ['i1'] })
    vi.stubGlobal('$fetch', f)
    await useFavorites().toggleFavorite('i1')
    expect(f).toHaveBeenCalledWith('/api/favorites/toggle', { method: 'POST', body: { id: 'i1' } })
    expect(nav).not.toHaveBeenCalled()
    expect(userState.user.value?.favoriteIds).toEqual(['i1'])
  })

  it('toggles and syncs the user favorites (remove) when logged in', async () => {
    userState.isLogged.value = true
    userState.user.value = { favoriteIds: ['i1', 'i2'] }
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ favoriteIds: ['i2'] }))
    await useFavorites().toggleFavorite('i1')
    expect(userState.user.value?.favoriteIds).toEqual(['i2'])
  })

  it('skips the sync when logged in but the user object is absent', async () => {
    userState.isLogged.value = true
    userState.user.value = null
    const f = vi.fn().mockResolvedValue({ favoriteIds: ['i1'] })
    vi.stubGlobal('$fetch', f)
    await expect(useFavorites().toggleFavorite('i1')).resolves.toBeUndefined()
    expect(f).toHaveBeenCalledOnce()
    expect(userState.user.value).toBeNull()
  })

  it('propagates the API error without mutating favorites (rollback)', async () => {
    userState.isLogged.value = true
    userState.user.value = { favoriteIds: ['existing'] }
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(useFavorites().toggleFavorite('i1')).rejects.toThrow('boom')
    expect(userState.user.value?.favoriteIds).toEqual(['existing'])
    expect(nav).not.toHaveBeenCalled()
  })
})
