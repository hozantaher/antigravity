import { buildImageUrl, type ImageOptions } from '~/utils/imageUrl'

type ImageSize = '56x56' | '192x144' | '380x280' | '500x370' | '800x600' | '1200x800'

const SIZE_MAP: Record<ImageSize, { width: number; height: number }> = {
  '56x56': { width: 56, height: 56 },
  '192x144': { width: 192, height: 144 },
  '380x280': { width: 380, height: 280 },
  '500x370': { width: 500, height: 370 },
  '800x600': { width: 800, height: 600 },
  '1200x800': { width: 1200, height: 800 },
}

export const useImageProcessing = () => {
  const config = useRuntimeConfig()
  const endpoint = (config.public as Record<string, string>).imageProcessingUrl || ''

  const getImageUrl = (source: string, options: ImageOptions = {}): string => buildImageUrl(endpoint, source, options)

  const imgUrl = (url: string, size: ImageSize = '380x280'): string => {
    if (!url) return ''
    return buildImageUrl(endpoint, url, SIZE_MAP[size])
  }

  const getSearchImage = (source: string): string => imgUrl(source, '56x56')
  const getCardImage = (source: string): string => imgUrl(source, '380x280')
  const getMediumImage = (source: string): string => imgUrl(source, '500x370')
  const getLargeImage = (source: string): string => imgUrl(source, '1200x800')

  // Social-share image: 1200×630 (the og:image ratio), JPEG for the widest scraper compatibility
  // (some social crawlers still don't render webp). withoutEnlargement keeps small sources as-is.
  const getOgImage = (source: string): string =>
    source ? buildImageUrl(endpoint, source, { width: 1200, height: 630, format: 'jpeg' }) : ''

  // DPR srcset (1×/2×) for fixed-size slots (cards, hero): same crop at standard and retina
  // densities. withoutEnlargement caps the 2× at the original, so it never upscales.
  const dprSrcset = (source: string, size: ImageSize): string => {
    if (!source) return ''
    const { width, height } = SIZE_MAP[size]
    const x1 = buildImageUrl(endpoint, source, { width, height })
    const x2 = buildImageUrl(endpoint, source, { width: width * 2, height: height * 2 })
    return `${x1} 1x, ${x2} 2x`
  }

  // Width-descriptor srcset for full-bleed/responsive contexts (pair with a `sizes` attr).
  // Width-only resize preserves aspect for both landscape photos and 2:1 panos.
  const widthSrcset = (source: string, widths: number[]): string => {
    if (!source) return ''
    return widths.map(w => `${buildImageUrl(endpoint, source, { width: w })} ${w}w`).join(', ')
  }

  return {
    getImageUrl,
    imgUrl,
    getSearchImage,
    getCardImage,
    getMediumImage,
    getLargeImage,
    getOgImage,
    dprSrcset,
    widthSrcset,
  }
}
