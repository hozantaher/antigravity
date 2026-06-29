// Pure builders for the image-processing extension URL contract. Shared by the client
// composable (useImageProcessing) and the server-side email image helper so the tricky
// firebasestorage double-encode and the operations-array shape live in exactly one place.

export interface ImageOptions {
  width?: number
  height?: number
  format?: 'jpeg' | 'webp' | 'png' | 'avif'
  quality?: number
}

type Operation = Record<string, unknown>

// Storage URLs need double-encoding — the extension decodes once before fetching.
export const prepareStorageUrl = (url: string): string => {
  if (!url) return ''
  if (url.includes('firebasestorage.googleapis.com')) {
    const match = url.match(/^(https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/)([^?]+)(\?.*)?$/)
    if (match) {
      const base = match[1]
      const encodedPath = match[2]!
      const query = match[3] || '?alt=media'
      const doubleEncodedPath = encodeURIComponent(encodedPath)
      return `${base}${doubleEncodedPath}${query.includes('alt=media') ? query : `${query}&alt=media`}`
    }
  }
  return url
}

export const buildImageUrl = (endpoint: string, source: string, options: ImageOptions = {}): string => {
  if (!endpoint || !source || !source.startsWith('http')) return source

  const imageUrl = prepareStorageUrl(source)
  const { width, height, format = 'webp', quality = 85 } = options

  const operations: Operation[] = [{ operation: 'input', type: 'url', url: imageUrl }]

  if (width || height) {
    operations.push({ operation: 'resize', width, height, fit: 'cover', withoutEnlargement: true })
  }

  operations.push({ operation: 'output', format, quality })

  return `${endpoint}/process?operations=${encodeURIComponent(JSON.stringify(operations))}`
}
