// Single source of truth for the cookie/analytics consent. The localStorage key
// is shared with the old auction24 banner so returning visitors stay accepted.
// gtag.js is configured with initMode: 'manual' (nuxt.config) and loads only here,
// once the user has accepted — so there is no tracking before consent.
export const useCookieConsent = () => {
  const accepted = useLocalStorage('cookies-consent', false)
  const { gtag, initialize } = useGtag()
  const enabled = Boolean(useRuntimeConfig().public.gtag?.id)

  const enableAnalytics = () => {
    if (!enabled) return
    initialize()
    gtag('consent', 'update', {
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    })
  }

  const accept = () => {
    accepted.value = true
    enableAnalytics()
  }

  return { accepted, accept, enableAnalytics }
}
