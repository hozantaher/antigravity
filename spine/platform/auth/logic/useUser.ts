import type { User as FirebaseUser } from 'firebase/auth'
import type { RegisterProfile, User } from '~/models'
import { UserRole, isUserEligibleToBid } from '~/models'
import {
  ensureFirebaseAuth,
  ensureAuthStateListener,
  getCachedFirebaseAuth,
  markStoredFirebaseSession,
  clearStoredFirebaseSessionMarker,
} from '~/features/platform/auth-account/logic/firebaseClient'
import { getAuthHeader } from '~/features/platform/auth-account/logic/authHeader'
import { markAuthReady, whenAuthReady } from '~/features/platform/auth-account/logic/state'
import { resetCompare } from '~/features/demand/compare/logic/useCompare'

export interface RegisterPayload extends RegisterProfile {
  email: string
  password: string
}

// Carries the registration profile from register() to the token exchange (the
// onAuthStateChanged listener may fire the exchange first; both read this so the
// row is created WITH the profile regardless of who wins the race).
let pendingProfile: RegisterProfile | null = null

const firebaseErr = (e: unknown): string => (e as { code?: string })?.code ?? 'auth/error'

export default function useUser() {
  const user = useState<User | undefined>('auth:user', () => undefined)
  const backlink = useState<string | undefined>('auth:backlink', () => undefined)
  const localePath = useLocalePath()

  // Fetch the current user (Bearer header attached). Anonymous → undefined.
  const init = async (): Promise<User | null> => {
    try {
      const me = await $fetch<User | null>('/api/me', { headers: await getAuthHeader() })
      user.value = me ?? undefined
    } catch {
      user.value = undefined
    }
    return user.value ?? null
  }

  // Reached from the onAuthStateChanged listener — a detached async callback with
  // no active Vue instance, so useI18n() (which relies on inject()) would throw.
  // useNuxtApp().$i18n has a global client fallback and works in that context.
  const applyUserLanguage = () => {
    const { $i18n } = useNuxtApp()
    const code = user.value?.language?.code
    if (code && ($i18n.availableLocales as string[]).includes(code)) $i18n.setLocale(code as 'cz')
  }

  // Verified ID token → app user row. Upsert is idempotent so double exchange
  // (explicit + listener) is harmless.
  const exchange = async (fbUser: FirebaseUser): Promise<User> => {
    const idToken = await fbUser.getIdToken()
    const profile = pendingProfile ?? undefined
    pendingProfile = null
    const result = await $fetch<User>('/api/auth/login', { method: 'POST', body: { idToken, profile } })
    user.value = result
    return result
  }

  // Tear down all client-side session state: the returning-user marker, the user row, and
  // anonymous per-user stores (compare picks). Shared by explicit and cross-tab sign-out so
  // neither path leaks state on a shared device.
  const clearLocalSession = () => {
    clearStoredFirebaseSessionMarker()
    user.value = undefined
    resetCompare()
  }

  // Installs onAuthStateChanged once. Restores returning users, handles cross-tab
  // sign-out, and resolves auth readiness for route guards.
  const ensureAuthBootstrap = async () => {
    try {
      const auth = await ensureAuthStateListener({
        onSignIn: async fbUser => {
          markStoredFirebaseSession()
          try {
            await exchange(fbUser).catch(() => init())
            applyUserLanguage()
          } finally {
            markAuthReady()
          }
        },
        onSignOut: () => {
          clearLocalSession()
          markAuthReady()
        },
      })
      if (!auth) markAuthReady()
      return auth
    } catch {
      // A failed Firebase bootstrap (e.g. a chunk-load error after a deploy) must not wedge route
      // guards / app init that await auth readiness — resolve as anonymous so navigation proceeds.
      markAuthReady()
      return undefined
    }
  }

  // Resolves once Firebase has determined the initial auth state. Used by guards.
  const ensureAuthResolved = (): Promise<void> => whenAuthReady()

  const signWithCredentials = async (email: string, passw: string): Promise<string | undefined> => {
    const auth = await ensureFirebaseAuth()
    if (!auth) return 'auth/not-configured'
    await ensureAuthBootstrap()
    try {
      const { signInWithEmailAndPassword } = await import('firebase/auth')
      const cred = await signInWithEmailAndPassword(auth, email, passw)
      await exchange(cred.user)
      return undefined
    } catch (e) {
      return firebaseErr(e)
    }
  }

  const register = async (payload: RegisterPayload): Promise<string | undefined> => {
    const auth = await ensureFirebaseAuth()
    if (!auth) return 'auth/not-configured'
    await ensureAuthBootstrap()
    const { email, password, ...profile } = payload
    pendingProfile = profile
    try {
      const { createUserWithEmailAndPassword, updateProfile } = await import('firebase/auth')
      const cred = await createUserWithEmailAndPassword(auth, email, password)
      if (profile.fullName) {
        await updateProfile(cred.user, { displayName: profile.fullName })
        await cred.user.getIdToken(true)
      }
      await exchange(cred.user)
      // Best-effort branded verification e-mail right after sign-up; a delivery
      // failure must not fail registration, so the result is ignored.
      await sendVerificationEmail()
      return undefined
    } catch (e) {
      pendingProfile = null
      return firebaseErr(e)
    }
  }

  const signWithProvider = async (which: 'google' | 'facebook'): Promise<string | undefined> => {
    const auth = await ensureFirebaseAuth()
    if (!auth) return 'auth/not-configured'
    await ensureAuthBootstrap()
    try {
      const fb = await import('firebase/auth')
      const provider = which === 'google' ? new fb.GoogleAuthProvider() : new fb.FacebookAuthProvider()
      const cred = await fb.signInWithPopup(auth, provider)
      await exchange(cred.user)
      return undefined
    } catch (e) {
      return firebaseErr(e)
    }
  }

  const signWithGoogle = () => signWithProvider('google')
  const signWithFacebook = () => signWithProvider('facebook')

  // Server mints the reset link (Firebase Admin) and sends our own e-mail.
  // Anti-enumeration: the endpoint responds 2xx even for unknown addresses, so a
  // success here never reveals whether the account exists.
  const resetPassword = async (email: string, locale?: string): Promise<string | undefined> => {
    try {
      await $fetch('/api/auth/request-password-reset', { method: 'POST', body: { email, locale } })
      return undefined
    } catch (e) {
      return (e as { statusCode?: number }).statusCode === 429 ? 'auth/too-many-requests' : 'auth/error'
    }
  }

  const signOut = async (reload = false) => {
    try {
      await $fetch('/api/auth/logout', { method: 'POST', headers: await getAuthHeader() })
    } catch {
      /* DB cutoff is best-effort here; firebase signOut below is the real local logout */
    }
    const auth = getCachedFirebaseAuth()
    if (auth) {
      const { signOut: firebaseSignOut } = await import('firebase/auth')
      await firebaseSignOut(auth).catch(() => {})
    }
    clearLocalSession()
    if (reload) await navigateTo(localePath('/sign'))
  }

  const removeUser = async () => {
    try {
      await $fetch('/api/me', { method: 'DELETE', headers: await getAuthHeader() })
    } catch {
      /* best-effort; the Firebase sign-out below still clears the local session */
    }
    await signOut(true)
  }

  // Persist self-editable profile fields, then adopt the server's canonical row.
  const updateProfile = async (patch: Partial<User>): Promise<boolean> => {
    if (!user.value) return false
    try {
      user.value = await $fetch<User>('/api/me', { method: 'PUT', body: patch })
      return true
    } catch {
      return false
    }
  }

  // Real Firebase email verification / change. The DB picks up the new state on
  // the next login via syncAuthFields, so we don't fake user.value here.
  const firebaseUser = async () => (getCachedFirebaseAuth() ?? (await ensureFirebaseAuth()))?.currentUser ?? null

  // Server mints the verification link (Firebase Admin) and sends our own e-mail.
  const sendVerificationEmail = async (): Promise<string | undefined> => {
    try {
      await $fetch('/api/auth/request-email-verification', { method: 'POST', headers: await getAuthHeader() })
      return undefined
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 401) return 'auth/no-user'
      return status === 429 ? 'auth/too-many-requests' : 'auth/error'
    }
  }

  const changeEmail = async (newEmail: string): Promise<string | undefined> => {
    const current = await firebaseUser()
    if (!current) return 'auth/no-user'
    try {
      const { verifyBeforeUpdateEmail } = await import('firebase/auth')
      await verifyBeforeUpdateEmail(current, newEmail)
      return undefined
    } catch (e) {
      return firebaseErr(e)
    }
  }

  const isLogged = computed(() => user.value !== undefined)
  const isAdmin = computed(() => user.value?.roles.includes(UserRole.admin) ?? false)
  const hasFavorites = computed(() => user.value?.favoriteIds.length)
  const emailVerified = computed(() => user.value?.emailVerified ?? false)
  const hasDeposit = computed(() => user.value?.depositBalance?.amount)
  const isEligibleToBid = computed(() => (user.value ? isUserEligibleToBid(user.value) : false))

  return {
    user,
    backlink,
    isLogged,
    isAdmin,
    hasFavorites,
    emailVerified,
    hasDeposit,
    isEligibleToBid,
    init,
    ensureAuthBootstrap,
    ensureAuthResolved,
    applyUserLanguage,
    updateProfile,
    sendVerificationEmail,
    changeEmail,
    signWithCredentials,
    register,
    resetPassword,
    signWithGoogle,
    signWithFacebook,
    signOut,
    removeUser,
    dispose: () => {},
  }
}
