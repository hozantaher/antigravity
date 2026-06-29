// Owns the tracking lifecycle: enable collection once consent is granted (mirrors
// gtag-consent.client.ts), and drive the flush triggers (interval · tab-hide · unload).
// Gated by the master flag so nothing is collected when the engine is off.
export default defineNuxtPlugin(() => {
  if (useRuntimeConfig().public.recoEnabled !== true) return

  const tracking = useTracking()
  const { accepted } = useCookieConsent()

  // Returning visitors (localStorage 'cookies-consent') enable on boot; first-timers the
  // instant they accept in CookiesBar.vue. Before that, enqueue() is a no-op and no vid is set.
  watch(accepted, ok => ok && tracking.enable(), { immediate: true })

  useIntervalFn(() => tracking.flush(), 8000)
  useEventListener(document, 'visibilitychange', () => document.visibilityState === 'hidden' && tracking.flush(true))
  useEventListener(window, 'pagehide', () => tracking.flush(true))
})
