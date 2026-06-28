import { getCachedFirebaseAuth } from '~/features/platform/auth-account/logic/firebaseClient'

// Anon users (firebase never loaded) get an empty header, so the server-side
// session helper returns null. Logged-in users get a fresh ID token.
export const getAuthHeader = async (): Promise<Record<string, string>> => {
  const auth = getCachedFirebaseAuth()
  const firebaseUser = auth?.currentUser
  if (!firebaseUser) return {}
  const token = await firebaseUser.getIdToken()
  return { Authorization: `Bearer ${token}` }
}
