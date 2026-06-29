import { randomUUID } from 'node:crypto'

export const ALLOWED_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'] as const
export type AllowedImageContentType = (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number]

// Trust content-type and rewrite the extension so callers can't smuggle a .php as image/jpeg.
const CONTENT_TYPE_TO_EXT: Record<AllowedImageContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

// 360 equirectangular panos run large; keep headroom over the 10MB the UI used to suggest.
export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024

export type UploadValidationError = 'invalid_item_id' | 'unsupported_content_type' | 'file_too_large' | 'empty_file'

export type UploadValidationResult = { ok: true; ext: string } | { ok: false; error: UploadValidationError }

// Path-traversal guard — reject itemIds outside alphanumeric+dash/underscore so they can't escape public/ads/{itemId}/.
const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export const validateImageUpload = (itemId: string, contentType: string, sizeBytes: number): UploadValidationResult => {
  if (!ITEM_ID_PATTERN.test(itemId)) return { ok: false, error: 'invalid_item_id' }
  if (!(ALLOWED_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return { ok: false, error: 'unsupported_content_type' }
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { ok: false, error: 'empty_file' }
  if (sizeBytes > MAX_IMAGE_SIZE_BYTES) return { ok: false, error: 'file_too_large' }
  return { ok: true, ext: CONTENT_TYPE_TO_EXT[contentType as AllowedImageContentType] }
}

// Grouped by itemId to match the layout of pre-existing ads (public/ads/{itemId}/…).
// Random filename avoids collisions and decouples from the original upload name. itemId is
// validated upstream (validateImageUpload); the guard here keeps this path builder safe alone.
export const buildUploadObjectPath = (itemId: string, ext: string): string => {
  if (!ITEM_ID_PATTERN.test(itemId)) {
    throw new Error('buildUploadObjectPath: invalid itemId (must be alphanumeric + dash/underscore)')
  }
  return `public/ads/${itemId}/${randomUUID()}.${ext}`
}
