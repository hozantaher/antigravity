import { create } from 'zustand'
import { onAuthStateChanged, signOut as fbSignOut } from 'firebase/auth'
import { auth } from '../firebaseInit.js'

export const useAuthStore = create(() => ({
  user: null,
  loading: true,
}))

// DEV/E2E auth seam — bypass the Firebase login gate ONLY in the Vite dev
// build (`import.meta.env.DEV`) when an `operator_id` cookie is present (the
// same cookie the Playwright smoke harness sets). This lets automated smoke
// specs + local piloting reach the dashboard without a Google sign-in. A production
// build compiles `import.meta.env.DEV` to `false`, so this path never ships;
// real local operators (no operator_id cookie) still authenticate through
// Firebase unchanged.
function e2eBypassUser() {
  try {
    if (!import.meta.env?.DEV) return null
    if (typeof document === 'undefined') return null
    if (/(?:^|;\s*)operator_id=/.test(document.cookie)) {
      return { uid: 'e2e-operator', email: 'operator@local.dev' }
    }
  } catch { /* ignore */ }
  return null
}

const _e2eUser = e2eBypassUser()
if (_e2eUser) {
  useAuthStore.setState({ user: _e2eUser, loading: false })
} else {
  onAuthStateChanged(auth, (user) => {
    useAuthStore.setState({ user, loading: false })
  })
}

export const signOut = () => fbSignOut(auth)
