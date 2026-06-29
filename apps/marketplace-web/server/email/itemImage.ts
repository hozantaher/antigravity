import { buildImageUrl } from '~/utils/imageUrl'

// Email-safe item image URL: jpeg (email clients are unreliable on webp) at a fixed small size.
// Reuses the shared image-processing URL builder (utils/imageUrl) so the storage encoding and
// operations-array contract live in one place.
export const emailItemImageUrl = (source: string): string => {
  const endpoint = (useRuntimeConfig().public as Record<string, string>).imageProcessingUrl || ''
  return buildImageUrl(endpoint, source, { width: 360, height: 240, format: 'jpeg', quality: 80 })
}
