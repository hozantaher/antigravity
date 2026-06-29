import {
  buildImageUrl,
  buildProxyUrl,
  derivativeUrl,
  isAllowedImageSource,
  isDerivativeSpec,
  sizeToSpec,
  type ImageOptions,
} from '~/utils/imageUrl'

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
  const pub = config.public as Record<string, unknown>
  const endpoint = (pub.imageProcessingUrl as string) || ''
  const useCache = Boolean(pub.imageCacheEnabled)
  const useDerivatives = Boolean(pub.derivativesEnabled)
  const derivativeBucket = ((pub.firebase as { storageBucket?: string } | undefined)?.storageBucket as string) || ''

  // Tier 2/3: the same-origin /img CDN proxy when enabled, else the direct on-the-fly processing URL.
  const proxyOrDirect = (source: string, options: ImageOptions): string =>
    useCache && source.startsWith('http') && isAllowedImageSource(source)
      ? buildProxyUrl('', source, options)
      : buildImageUrl(endpoint, source, options)

  // Three tiers, fastest first: (1) a pre-generated static derivative served straight from GCS (no
  // per-image compute), for the ladder sizes; (2) the /img cache proxy; (3) the direct processing URL.
  const getImageUrl = (source: string, options: ImageOptions = {}): string => {
    if (useDerivatives && source && source.startsWith('http') && isAllowedImageSource(source)) {
      const spec = sizeToSpec(options.width, options.height)
      if (isDerivativeSpec(spec)) {
        const derivative = derivativeUrl(derivativeBucket, source, spec)
        if (derivative) return derivative
      }
    }
    return proxyOrDirect(source, options)
  }

  // The /img (or direct) URL for the same source+size, SKIPPING the derivative tier — used as the
  // <img> @error fallback (BaseImage) when a static derivative is missing (e.g. backfill gap).
  const fallbackUrl = (source: string, options: ImageOptions = {}): string =>
    source ? proxyOrDirect(source, options) : ''

  const imgUrl = (url: string, size: ImageSize = '380x280'): string => {
    if (!url) return ''
    return getImageUrl(url, SIZE_MAP[size])
  }

  const getSearchImage = (source: string): string => imgUrl(source, '56x56')
  const getCardImage = (source: string): string => imgUrl(source, '380x280')
  const getMediumImage = (source: string): string => imgUrl(source, '500x370')
  const getLargeImage = (source: string): string => imgUrl(source, '1200x800')

  // DPR srcset (1×/2×) for fixed-size slots (cards, hero): same crop at standard and retina
  // densities. withoutEnlargement caps the 2× at the original, so it never upscales.
  const dprSrcset = (source: string, size: ImageSize): string => {
    if (!source) return ''
    const { width, height } = SIZE_MAP[size]
    const x1 = getImageUrl(source, { width, height })
    const x2 = getImageUrl(source, { width: width * 2, height: height * 2 })
    return `${x1} 1x, ${x2} 2x`
  }

  // Width-descriptor srcset for full-bleed/responsive contexts (pair with a `sizes` attr).
  // Width-only resize preserves aspect for both landscape photos and 2:1 panos.
  const widthSrcset = (source: string, widths: number[]): string => {
    if (!source) return ''
    return widths.map(w => `${getImageUrl(source, { width: w })} ${w}w`).join(', ')
  }

  return {
    getImageUrl,
    fallbackUrl,
    imgUrl,
    getSearchImage,
    getCardImage,
    getMediumImage,
    getLargeImage,
    dprSrcset,
    widthSrcset,
  }
}
