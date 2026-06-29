// Bearer auth renders anonymous on the server; decide on the client once
// Firebase has resolved the initial auth state.
export default defineNuxtRouteMiddleware(async () => {
  if (import.meta.server) return
  const { user, ensureAuthResolved } = useUser()
  const localePath = useLocalePath()
  await ensureAuthResolved()
  if (!user.value) return navigateTo(localePath('/sign'))
})
