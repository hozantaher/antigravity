// Returning visitor who already accepted cookies → load gtag.js on app start.
// First-time consent is handled by the Accept button in CookiesBar.vue.
export default defineNuxtPlugin(() => {
  const { accepted, enableAnalytics } = useCookieConsent()
  if (accepted.value) enableAnalytics()
})
