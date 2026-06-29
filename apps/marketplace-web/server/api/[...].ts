// Unmatched /api/** paths (and method mismatches on real endpoints, e.g. GET on a
// POST-only route) would otherwise fall through to the Nuxt SPA renderer and return
// a 200 HTML page (a soft-404). Send a proper JSON 404 so the API contract holds.
export default defineEventHandler(event => {
  throw createError({ statusCode: 404, statusMessage: `No API route: ${event.method} ${event.path}` })
})
