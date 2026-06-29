import { create, countForUser } from '~/server/repos/savedSearchRepo'
import { isValidSavedSearchName, normalizeSavedSearchQuery, SAVED_SEARCH_MAX_PER_USER } from '~/models'
import type { SearchQuery } from '~/models'

// Create a saved search for the current user. Validates the name, normalizes the query (a junk query
// is sanitized, never rejected — same lenience as /api/search), and enforces the per-user cap (409).
// The id + userId are server-controlled (never from the body).
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  enforceRateLimit(event, { bucket: 'saved-search-create', limit: 20, windowMs: 60_000, key: user.id })

  const body = (await readBody(event).catch(() => null)) as {
    name?: unknown
    query?: SearchQuery
    alertEnabled?: unknown
  } | null
  if (!isValidSavedSearchName(body?.name)) {
    throw createError({ statusCode: 422, statusMessage: 'A non-empty name is required' })
  }

  if ((await countForUser(user.id)) >= SAVED_SEARCH_MAX_PER_USER) {
    throw createError({ statusCode: 409, statusMessage: 'Saved search limit reached' })
  }

  // ms + random suffix id (parity with itemRepo.createItem) — second-resolution ids could collide.
  const id = `ss${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const saved = await create(id, user.id, {
    name: body!.name as string,
    query: normalizeSavedSearchQuery(body?.query),
    alertEnabled: typeof body?.alertEnabled === 'boolean' ? body.alertEnabled : undefined,
  })
  setResponseStatus(event, 201)
  return saved
})
