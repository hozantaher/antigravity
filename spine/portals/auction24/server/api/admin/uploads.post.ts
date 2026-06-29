import { requireAdmin } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { uploadAdImage, type UploadAdImageError } from '../../repos/uploadRepo'

const ERROR_STATUS: Record<UploadAdImageError, { status: number; message: string }> = {
  invalid_item_id: { status: 400, message: 'Invalid itemId' },
  unsupported_content_type: { status: 415, message: 'Unsupported image content type' },
  file_too_large: { status: 413, message: 'File exceeds maximum size' },
  empty_file: { status: 400, message: 'File is empty' },
  storage_unavailable: { status: 503, message: 'Storage is temporarily unavailable' },
}

export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  enforceRateLimit(event, { bucket: 'admin-image-upload', limit: 120, windowMs: 60_000, key: admin.id })

  const parts = await readMultipartFormData(event)
  const filePart = parts?.find(p => p.name === 'file' && p.filename)
  const itemId =
    parts
      ?.find(p => p.name === 'itemId')
      ?.data?.toString('utf-8')
      .trim() ?? ''

  if (!filePart?.data) throw createError({ statusCode: 400, statusMessage: 'Missing file' })
  if (!itemId) throw createError({ statusCode: 400, statusMessage: 'Missing itemId' })

  const contentType = filePart.type ?? 'application/octet-stream'

  const result = await uploadAdImage({ itemId, contentType, buffer: filePart.data })

  if (!result.ok) {
    const mapped = ERROR_STATUS[result.error]
    throw createError({ statusCode: mapped.status, statusMessage: mapped.message })
  }

  return { url: result.url, objectPath: result.objectPath }
})
