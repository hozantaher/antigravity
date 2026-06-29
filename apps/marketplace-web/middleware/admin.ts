// Admin pages are client-rendered (routeRules ssr:false); resolve auth on the
// client then gate on the admin role.
export default defineNuxtRouteMiddleware(async () => {
  if (import.meta.server) return
  const { isAdmin, ensureAuthResolved } = useUser()
  const localePath = useLocalePath()
  await ensureAuthResolved()
  if (!isAdmin.value) return navigateTo(localePath('/'))
})
