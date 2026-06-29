import { update } from '~/server/repos/savedSearchRepo'

// Rename a saved search or toggle its email alert. Owner-scoped: the repo's update only matches the
// caller's own row, so a cross-user id returns undefined → 404 (never 403, no existence leak). The
// repo applies the name/alertEnabled whitelist — userId/query/timestamps can't be patched.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  enforceRateLimit(event, { bucket: 'saved-search-update', limit: 30, windowMs: 60_000, key: user.id })

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

  const body = (await readBody(event).catch(() => null)) as { name?: unknown; alertEnabled?: unknown } | null
  const saved = await update(id, user.id, body ?? {})
  if (!saved) throw createError({ statusCode: 404, statusMessage: 'Saved search not found' })
  return saved
})
