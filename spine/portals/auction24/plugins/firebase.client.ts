import { hasStoredFirebaseSession } from '~/features/platform/auth-account/logic/firebaseClient'
import { markAuthReady } from '~/features/platform/auth-account/logic/state'

// Anonymous visitors flip authReady true and never load firebase. Returning
// users hydrate via the onAuthStateChanged listener in useUser.
export default defineNuxtPlugin(() => {
  if (!hasStoredFirebaseSession()) {
    markAuthReady()
    return
  }
  // Kick off session restore but DON'T await it — hydration must not block on the Firebase chunk
  // load + token round-trip for returning users. ensureAuthBootstrap calls markAuthReady in every
  // branch, so route guards (which await whenAuthReady) still resolve; the user state then patches
  // the already-painted anonymous UI when it settles.
  void useUser().ensureAuthBootstrap()
})
