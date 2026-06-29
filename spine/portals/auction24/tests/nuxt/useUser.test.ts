import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { UserRole, type User } from '~/models'

import useUser from '~/features/platform/auth-account/logic/useUser'

const fbClient = vi.hoisted(() => ({
  ensureFirebaseAuth: vi.fn(),
  ensureAuthStateListener: vi.fn(),
  getCachedFirebaseAuth: vi.fn(),
  markStoredFirebaseSession: vi.fn(),
  clearStoredFirebaseSessionMarker: vi.fn(),
}))
vi.mock('~/features/platform/auth-account/logic/firebaseClient', () => fbClient)
vi.mock('~/features/platform/auth-account/logic/authHeader', () => ({ getAuthHeader: vi.fn().mockResolvedValue({}) }))

const authState = vi.hoisted(() => ({
  markAuthReady: vi.fn(),
  whenAuthReady: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('~/features/platform/auth-account/logic/state', () => authState)

const resetCompare = vi.hoisted(() => vi.fn())
vi.mock('~/features/demand/compare/logic/useCompare', () => ({ resetCompare }))

const fb = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  updateProfile: vi.fn().mockResolvedValue(undefined),
  signInWithPopup: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
  verifyBeforeUpdateEmail: vi.fn().mockResolvedValue(undefined),
  GoogleAuthProvider: vi.fn(),
  FacebookAuthProvider: vi.fn(),
}))
vi.mock('firebase/auth', () => fb)

const navigateTo = vi.hoisted(() => vi.fn())
mockNuxtImport('navigateTo', () => navigateTo)

// Production strategy is prefix_except_default with default `cz`, so localePath('/sign')
// resolves to '/sign'. The test runtime picks `en`, which would yield '/en/sign'; mock the
// identity behavior so the redirect assertion tracks production, not the harness locale.
mockNuxtImport('useLocalePath', () => () => (p: string) => p)

const authObj = {}
const fbUser = { getIdToken: vi.fn().mockResolvedValue('idtok') }

beforeEach(() => {
  vi.clearAllMocks()
  useUser().user.value = undefined
  fbUser.getIdToken.mockResolvedValue('idtok')
  fbClient.ensureFirebaseAuth.mockResolvedValue(authObj)
  fbClient.ensureAuthStateListener.mockResolvedValue(authObj)
  fbClient.getCachedFirebaseAuth.mockReturnValue(authObj)
})

describe('useUser data methods', () => {
  it('init populates the user, clears it on error', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 'u1', roles: [], favoriteIds: [] }))
    const u = useUser()
    expect((await u.init())?.id).toBe('u1')
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('401')))
    expect(await u.init()).toBeNull()
    expect(u.user.value).toBeUndefined()
  })

  it('init maps a null body to undefined', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(null))
    const u = useUser()
    expect(await u.init()).toBeNull()
    expect(u.user.value).toBeUndefined()
  })

  it('updateProfile adopts the server row, returns false when not logged in', async () => {
    const u = useUser()
    expect(await u.updateProfile({ fullName: 'X' })).toBe(false) // no user
    u.user.value = { id: 'u1', roles: [], favoriteIds: [] } as unknown as User
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 'u1', fullName: 'X', roles: [], favoriteIds: [] }))
    expect(await u.updateProfile({ fullName: 'X' })).toBe(true)
    expect(u.user.value?.fullName).toBe('X')
  })

  it('updateProfile returns false when the server rejects', async () => {
    const u = useUser()
    u.user.value = { id: 'u1', roles: [], favoriteIds: [] } as unknown as User
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('500')))
    expect(await u.updateProfile({ fullName: 'X' })).toBe(false)
  })

  it('resetPassword maps 429 to a stable code, other errors to auth/error', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
    expect(await useUser().resetPassword('a@b.cz')).toBeUndefined()
    expect(await useUser().resetPassword('a@b.cz', 'en')).toBeUndefined()
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 429 }))
    expect(await useUser().resetPassword('a@b.cz')).toBe('auth/too-many-requests')
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 500 }))
    expect(await useUser().resetPassword('a@b.cz')).toBe('auth/error')
  })

  it('sendVerificationEmail maps 401/429/other and succeeds', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
    expect(await useUser().sendVerificationEmail()).toBeUndefined()
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 401 }))
    expect(await useUser().sendVerificationEmail()).toBe('auth/no-user')
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 429 }))
    expect(await useUser().sendVerificationEmail()).toBe('auth/too-many-requests')
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 500 }))
    expect(await useUser().sendVerificationEmail()).toBe('auth/error')
  })
})

describe('useUser Firebase flows', () => {
  it('signWithCredentials exchanges the token, guards unconfigured auth, maps errors', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 'u1', roles: [], favoriteIds: [] }))
    fb.signInWithEmailAndPassword.mockResolvedValue({ user: fbUser })
    expect(await useUser().signWithCredentials('a@b.cz', 'pw')).toBeUndefined()
    expect(useUser().user.value?.id).toBe('u1')

    fb.signInWithEmailAndPassword.mockRejectedValue({ code: 'auth/wrong-password' })
    expect(await useUser().signWithCredentials('a@b.cz', 'bad')).toBe('auth/wrong-password')

    fb.signInWithEmailAndPassword.mockRejectedValue({})
    expect(await useUser().signWithCredentials('a@b.cz', 'bad')).toBe('auth/error')

    fbClient.ensureFirebaseAuth.mockResolvedValue(null)
    expect(await useUser().signWithCredentials('a@b.cz', 'pw')).toBe('auth/not-configured')
  })

  it('register seeds the profile then sends a verification email', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 'u1', roles: [], favoriteIds: [] }))
    fb.createUserWithEmailAndPassword.mockResolvedValue({ user: fbUser })
    const err = await useUser().register({ email: 'a@b.cz', password: 'pw', fullName: 'Jan' } as never)
    expect(err).toBeUndefined()
    expect(fb.updateProfile).toHaveBeenCalled()
  })

  it('register without a full name skips the profile update', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 'u1', roles: [], favoriteIds: [] }))
    fb.createUserWithEmailAndPassword.mockResolvedValue({ user: fbUser })
    const err = await useUser().register({ email: 'a@b.cz', password: 'pw' } as never)
    expect(err).toBeUndefined()
    expect(fb.updateProfile).not.toHaveBeenCalled()
  })

  it('register guards unconfigured auth and maps creation errors', async () => {
    fbClient.ensureFirebaseAuth.mockResolvedValue(null)
    expect(await useUser().register({ email: 'a@b.cz', password: 'pw' } as never)).toBe('auth/not-configured')

    fbClient.ensureFirebaseAuth.mockResolvedValue(authObj)
    fb.createUserWithEmailAndPassword.mockRejectedValue({ code: 'auth/email-already-in-use' })
    expect(await useUser().register({ email: 'a@b.cz', password: 'pw', fullName: 'Jan' } as never)).toBe(
      'auth/email-already-in-use',
    )
  })

  it('signWithGoogle / signWithFacebook use a popup', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 'u1', roles: [], favoriteIds: [] }))
    fb.signInWithPopup.mockResolvedValue({ user: fbUser })
    expect(await useUser().signWithGoogle()).toBeUndefined()
    expect(await useUser().signWithFacebook()).toBeUndefined()
    expect(fb.signInWithPopup).toHaveBeenCalledTimes(2)
    expect(fb.GoogleAuthProvider).toHaveBeenCalled()
    expect(fb.FacebookAuthProvider).toHaveBeenCalled()
  })

  it('signWithProvider guards unconfigured auth and maps popup errors', async () => {
    fbClient.ensureFirebaseAuth.mockResolvedValue(null)
    expect(await useUser().signWithGoogle()).toBe('auth/not-configured')

    fbClient.ensureFirebaseAuth.mockResolvedValue(authObj)
    fb.signInWithPopup.mockRejectedValue({ code: 'auth/popup-closed-by-user' })
    expect(await useUser().signWithGoogle()).toBe('auth/popup-closed-by-user')
  })

  it('changeEmail returns auth/no-user without a current user, maps errors', async () => {
    fbClient.getCachedFirebaseAuth.mockReturnValue({ currentUser: null })
    fbClient.ensureFirebaseAuth.mockResolvedValue({ currentUser: null })
    expect(await useUser().changeEmail('new@x.cz')).toBe('auth/no-user')

    fbClient.getCachedFirebaseAuth.mockReturnValue({ currentUser: fbUser })
    expect(await useUser().changeEmail('new@x.cz')).toBeUndefined()
    expect(fb.verifyBeforeUpdateEmail).toHaveBeenCalled()

    fb.verifyBeforeUpdateEmail.mockRejectedValueOnce({ code: 'auth/requires-recent-login' })
    expect(await useUser().changeEmail('new@x.cz')).toBe('auth/requires-recent-login')
  })

  it('changeEmail falls back to ensureFirebaseAuth when no auth is cached', async () => {
    fbClient.getCachedFirebaseAuth.mockReturnValue(null)
    fbClient.ensureFirebaseAuth.mockResolvedValue({ currentUser: fbUser })
    expect(await useUser().changeEmail('new@x.cz')).toBeUndefined()
  })

  it('signOut clears the session and can redirect via localePath', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
    const u = useUser()
    u.user.value = { id: 'u1', roles: [], favoriteIds: [] } as never
    await u.signOut(true)
    expect(u.user.value).toBeUndefined()
    expect(fb.signOut).toHaveBeenCalled()
    expect(resetCompare).toHaveBeenCalled()
    expect(navigateTo).toHaveBeenCalledWith('/sign')
  })

  it('signOut without reload skips navigation and tolerates a logout failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('network')))
    await useUser().signOut()
    expect(fb.signOut).toHaveBeenCalled()
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('signOut skips firebase sign-out when no auth is cached', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
    fbClient.getCachedFirebaseAuth.mockReturnValue(null)
    await useUser().signOut()
    expect(fb.signOut).not.toHaveBeenCalled()
  })

  it('signOut swallows a firebase sign-out failure and still clears state', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
    fb.signOut.mockRejectedValueOnce(new Error('firebase down'))
    const u = useUser()
    u.user.value = { id: 'u1', roles: [], favoriteIds: [] } as never
    await u.signOut()
    expect(u.user.value).toBeUndefined()
    expect(fbClient.clearStoredFirebaseSessionMarker).toHaveBeenCalled()
  })

  it('removeUser deletes then signs out, tolerating a delete failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
    await useUser().removeUser()
    expect(fb.signOut).toHaveBeenCalled()
    expect(navigateTo).toHaveBeenCalledWith('/sign')

    vi.clearAllMocks()
    fbClient.getCachedFirebaseAuth.mockReturnValue(authObj)
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('500')))
    await useUser().removeUser()
    expect(fb.signOut).toHaveBeenCalled()
  })

  it('ensureAuthBootstrap installs the listener and wires the sign-in callback', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 'u1', roles: [], favoriteIds: [] }))
    await useUser().ensureAuthBootstrap()
    expect(fbClient.ensureAuthStateListener).toHaveBeenCalled()

    const { onSignIn } = fbClient.ensureAuthStateListener.mock.calls[0]![0]
    await onSignIn(fbUser)
    expect(fbClient.markStoredFirebaseSession).toHaveBeenCalled()
    expect(authState.markAuthReady).toHaveBeenCalled()
  })

  it('ensureAuthBootstrap sign-in falls back to init when exchange fails', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('login failed')) // exchange
      .mockResolvedValueOnce({ id: 'u1', roles: [], favoriteIds: [] }) // init
    vi.stubGlobal('$fetch', fetchFn)
    await useUser().ensureAuthBootstrap()
    const { onSignIn } = fbClient.ensureAuthStateListener.mock.calls[0]![0]
    await onSignIn(fbUser)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('ensureAuthBootstrap sign-out callback clears the session', async () => {
    await useUser().ensureAuthBootstrap()
    const { onSignOut } = fbClient.ensureAuthStateListener.mock.calls[0]![0]
    onSignOut()
    expect(fbClient.clearStoredFirebaseSessionMarker).toHaveBeenCalled()
    expect(authState.markAuthReady).toHaveBeenCalled()
  })

  it('ensureAuthBootstrap marks ready when the listener is unavailable', async () => {
    fbClient.ensureAuthStateListener.mockResolvedValue(null)
    const auth = await useUser().ensureAuthBootstrap()
    expect(auth).toBeNull()
    expect(authState.markAuthReady).toHaveBeenCalled()
  })

  it('ensureAuthResolved awaits readiness', async () => {
    await expect(useUser().ensureAuthResolved()).resolves.toBeUndefined()
    expect(authState.whenAuthReady).toHaveBeenCalled()
  })

  it('register carries the profile into the token exchange', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ id: 'u1', roles: [], favoriteIds: [] })
    vi.stubGlobal('$fetch', fetchFn)
    fb.createUserWithEmailAndPassword.mockResolvedValue({ user: fbUser })
    await useUser().register({ email: 'a@b.cz', password: 'pw', fullName: 'Jan' } as never)
    const loginCall = fetchFn.mock.calls.find(c => c[0] === '/api/auth/login')
    expect(loginCall?.[1]?.body?.profile?.fullName).toBe('Jan')
  })
})

describe('useUser language', () => {
  it('applyUserLanguage sets a matching available locale', () => {
    const { $i18n } = useNuxtApp()
    const setLocale = vi.spyOn($i18n, 'setLocale')
    const code = ($i18n.availableLocales as string[])[0]
    const u = useUser()
    u.user.value = { id: 'u1', roles: [], favoriteIds: [], language: { code } } as never
    u.applyUserLanguage()
    expect(setLocale).toHaveBeenCalledWith(code)
  })

  it('applyUserLanguage ignores an unavailable locale', () => {
    const { $i18n } = useNuxtApp()
    const setLocale = vi.spyOn($i18n, 'setLocale')
    const u = useUser()
    u.user.value = { id: 'u1', roles: [], favoriteIds: [], language: { code: 'not-a-locale' } } as never
    u.applyUserLanguage()
    expect(setLocale).not.toHaveBeenCalled()
  })

  it('applyUserLanguage is a no-op without a language code', () => {
    const { $i18n } = useNuxtApp()
    const setLocale = vi.spyOn($i18n, 'setLocale')
    const u = useUser()
    u.user.value = { id: 'u1', roles: [], favoriteIds: [] } as never
    u.applyUserLanguage()
    expect(setLocale).not.toHaveBeenCalled()
  })
})

describe('useUser computed flags', () => {
  it('derives flags from a fully eligible user row', () => {
    const u = useUser()
    expect(u.isLogged.value).toBe(false)
    expect(u.isAdmin.value).toBe(false)
    expect(u.hasFavorites.value).toBeUndefined()
    expect(u.emailVerified.value).toBe(false)
    expect(u.hasDeposit.value).toBeUndefined()
    expect(u.isEligibleToBid.value).toBe(false)

    u.user.value = {
      id: 'u1',
      roles: [UserRole.admin],
      favoriteIds: ['a'],
      emailVerified: true,
      depositRequired: false,
      phone: '+420',
      depositBalance: { amount: 100, currency: 'CZK' },
    } as never
    expect(u.isLogged.value).toBe(true)
    expect(u.isAdmin.value).toBe(true)
    expect(u.hasFavorites.value).toBe(1)
    expect(u.emailVerified.value).toBe(true)
    expect(u.hasDeposit.value).toBe(100)
    expect(u.isEligibleToBid.value).toBe(true)
  })

  it('isAdmin is false for a non-admin row', () => {
    const u = useUser()
    u.user.value = { id: 'u1', roles: [UserRole.user], favoriteIds: [] } as never
    expect(u.isAdmin.value).toBe(false)
  })

  it('dispose is a no-op', () => {
    expect(useUser().dispose()).toBeUndefined()
  })
})
