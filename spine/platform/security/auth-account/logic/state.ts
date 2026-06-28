// Client-only auth readiness. Flipped true once Firebase has determined the
// initial auth state (or immediately if Firebase isn't configured). Route
// guards await whenAuthReady() before deciding, since SSR renders anonymous.
let ready = false
let resolveReady: (() => void) | null = null
const readyPromise = new Promise<void>(resolve => {
  resolveReady = resolve
})

export const markAuthReady = (): void => {
  if (ready) return
  ready = true
  resolveReady?.()
  resolveReady = null
}

export const whenAuthReady = (): Promise<void> => readyPromise
