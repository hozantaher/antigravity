// Lazy-loader for firebase modules — keeps the Firebase JS chunk out of pages
// that don't touch auth. Pre-warmed by the client plugin for returning users
// (via hasStoredFirebaseSession), loaded on demand on Sign-In clicks.

import type { Auth, User as FirebaseUser } from 'firebase/auth'
import type { FirebaseApp } from 'firebase/app'

let authPromise: Promise<Auth | null> | null = null
let cachedAuth: Auth | null = null
let listenerInstalled = false

const loadApp = async (): Promise<FirebaseApp | null> => {
  const config = useRuntimeConfig().public.firebase as Record<string, string>
  if (!config?.apiKey) return null
  const { initializeApp, getApps } = await import('firebase/app')
  return getApps()[0] ?? initializeApp(config)
}

export const ensureFirebaseAuth = (): Promise<Auth | null> => {
  if (authPromise) return authPromise
  authPromise = (async () => {
    const app = await loadApp()
    if (!app) {
      console.warn('[firebase] FIREBASE_API_KEY not set — auth disabled. Set FIREBASE_* env vars to enable login.')
      return null
    }
    const { getAuth, connectAuthEmulator } = await import('firebase/auth')
    cachedAuth = getAuth(app)
    const emulator = useRuntimeConfig().public.firebase as Record<string, string>
    if (emulator.authEmulatorHost) {
      connectAuthEmulator(cachedAuth, `http://${emulator.authEmulatorHost}`, { disableWarnings: true })
    }
    return cachedAuth
  })()
  return authPromise
}

// Sync read for hot paths (getAuthHeader). Null until ensureFirebaseAuth resolves.
export const getCachedFirebaseAuth = (): Auth | null => cachedAuth

// Firebase persists auth state in IndexedDB, which can't be probed synchronously.
// We mirror a flag in localStorage so the plugin can decide whether to pre-warm.
const HAS_SESSION_KEY = 'garaaage:has-fb-session'

export const markStoredFirebaseSession = (): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(HAS_SESSION_KEY, '1')
  } catch {
    /* quota / private mode — worst case is no pre-warm */
  }
}

export const clearStoredFirebaseSessionMarker = (): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(HAS_SESSION_KEY)
  } catch {
    /* ignore */
  }
}

export const hasStoredFirebaseSession = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    if (window.localStorage.getItem(HAS_SESSION_KEY) === '1') return true
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith('firebase:authUser:')) return true
    }
  } catch {
    /* localStorage throws in private mode — treat as no session */
  }
  return false
}

export interface AuthStateListenerHandlers {
  onSignIn: (firebaseUser: FirebaseUser) => Promise<void> | void
  onSignOut: () => Promise<void> | void
}

// Attaches onAuthStateChanged once. Safe to call repeatedly — idempotent.
export const ensureAuthStateListener = async (handlers: AuthStateListenerHandlers): Promise<Auth | null> => {
  const auth = await ensureFirebaseAuth()
  if (!auth || listenerInstalled) return auth
  listenerInstalled = true
  const { onAuthStateChanged } = await import('firebase/auth')
  onAuthStateChanged(auth, async firebaseUser => {
    if (!firebaseUser) {
      await handlers.onSignOut()
      return
    }
    await handlers.onSignIn(firebaseUser)
  })
  return auth
}
