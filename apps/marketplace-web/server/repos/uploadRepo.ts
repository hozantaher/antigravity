import { randomUUID } from 'node:crypto'
import { getStorageBucket } from '../utils/firebase'
import { captureServerError } from '../utils/observability'
import { validateImageUpload, buildUploadObjectPath, type UploadValidationError } from '../utils/uploadValidation'

export type UploadAdImageError = UploadValidationError | 'storage_unavailable'

export type UploadAdImageResult =
  | { ok: true; url: string; objectPath: string }
  | { ok: false; error: UploadAdImageError }

interface UploadAdImageInput {
  itemId: string
  contentType: string
  buffer: Buffer
}

// The bucket isn't public, so reads go through a Firebase download token. Setting it via the
// Admin SDK (case preserved) makes the ?alt=media&token= URL resolve — same format as legacy ads,
// so existing items and the image-processing extension keep working.
const buildDownloadUrl = (bucketName: string, objectPath: string, token: string): string =>
  `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`

export const uploadAdImage = async (input: UploadAdImageInput): Promise<UploadAdImageResult> => {
  const validation = validateImageUpload(input.itemId, input.contentType, input.buffer.length)
  if (!validation.ok) return { ok: false, error: validation.error }

  const objectPath = buildUploadObjectPath(input.itemId, validation.ext)
  const token = randomUUID()

  try {
    const bucket = getStorageBucket()
    await bucket.file(objectPath).save(input.buffer, {
      resumable: false,
      contentType: input.contentType,
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    })
    return { ok: true, url: buildDownloadUrl(bucket.name, objectPath, token), objectPath }
  } catch (err) {
    captureServerError(err, { area: 'upload.adImage', tags: { objectPath } })
    return { ok: false, error: 'storage_unavailable' }
  }
}
