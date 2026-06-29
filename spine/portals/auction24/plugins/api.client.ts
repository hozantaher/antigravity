import { getAuthHeader } from '~/features/platform/auth-account/logic/authHeader'

// Inject the Firebase ID token on same-origin /api requests so every existing
// $fetch('/api/...') call is authenticated without per-call header threading.
// Client-only: SSR renders anonymous (Bearer auth, like garaaage-main).
export default defineNuxtPlugin(() => {
  const base = globalThis.$fetch
  globalThis.$fetch = base.create({
    async onRequest({ request, options }) {
      const url = typeof request === 'string' ? request : request instanceof Request ? request.url : ''
      if (!url.startsWith('/api')) return
      const header = await getAuthHeader()
      if (!header.Authorization) return
      const headers = new Headers(options.headers as HeadersInit | undefined)
      headers.set('Authorization', header.Authorization)
      options.headers = headers
    },
  }) as typeof globalThis.$fetch
})
