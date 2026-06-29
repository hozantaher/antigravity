import { createApiToken } from '~/server/repos/apiTokenRepo'

export default defineEventHandler(async event => {
  const admin = await requireInteractiveAdmin(event)
  enforceRateLimit(event, { bucket: 'admin-api-tokens', limit: 20, windowMs: 60_000, key: admin.id })

  const body = await readBody(event).catch(() => ({}))
  const name = (typeof body?.name === 'string' ? body.name : '').trim()
  if (name.length < 1 || name.length > 100) {
    throw createError({ statusCode: 400, statusMessage: 'Name must be 1–100 characters' })
  }

  const secret = useRuntimeConfig().internalApiSecret
  if (!secret) {
    throw createError({ statusCode: 500, statusMessage: 'API tokens are not configured (INTERNAL_API_SECRET missing)' })
  }

  return createApiToken({ name, createdBy: admin.id, createdByName: admin.fullName }, secret)
})
