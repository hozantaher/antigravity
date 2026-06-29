<script setup lang="ts">
const config = useRuntimeConfig()
const requestUrl = useRequestURL()

const origin = (config.public.baseUrl || requestUrl.origin).replace(/\/+$/, '')
const defaultImage = `${origin}/ms-icon-310x310.png`

// Image CDN (image-processing Cloud Function) origin. Warming the connection here lets the LCP
// hero/card image skip a cold DNS+TLS handshake. No `crossorigin`: <img> fetches aren't CORS, so
// a crossorigin preconnect would open a separate connection the image could not reuse.
const imageOrigin = (() => {
  try {
    return new URL(config.public.imageProcessingUrl).origin
  } catch {
    return ''
  }
})()

// i18n owns the language-routing SEO signals: <html lang/dir>, the per-locale self-canonical, the
// full hreflang cluster (all 12 locales + x-default), og:url and og:locale(:alternate). `seo: true`
// is required — non-strict mode defaults it to false and doesn't auto-patch the head, so we spread
// the reactive result into our own useHead alongside the Organization JSON-LD + image preconnect.
const i18nHead = useLocaleHead({ dir: true, lang: true, seo: true })

useHead(() => ({
  htmlAttrs: i18nHead.value.htmlAttrs ?? {},
  link: [
    ...(i18nHead.value.link ?? []),
    ...(imageOrigin
      ? [
          { rel: 'preconnect', href: imageOrigin },
          { rel: 'dns-prefetch', href: imageOrigin },
        ]
      : []),
  ],
  meta: i18nHead.value.meta ?? [],
  script: [
    {
      type: 'application/ld+json',
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Auction24.cz',
        url: origin,
        logo: `${origin}/android-icon-192x192.png`,
      }),
    },
  ],
}))

useSeoMeta({
  ogSiteName: 'Auction24.cz',
  ogType: 'website',
  ogTitle: 'Auction24.cz',
  ogDescription: 'Auction24.cz — aukce a prodej vozidel.',
  ogImage: defaultImage,
  twitterCard: 'summary_large_image',
  twitterImage: defaultImage,
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
