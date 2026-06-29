<script setup lang="ts">
const { t } = useI18n()
const config = useRuntimeConfig()
const requestUrl = useRequestURL()
const origin = (config.public.baseUrl || requestUrl.origin).replace(/\/+$/, '')

useSeo({
  title: () => t('seo.homeTitle'),
  description: () => t('seo.homeDescription'),
})

// WebSite + SearchAction → eligible for a Google sitelinks search box that targets /search/{q}.
useHead({
  script: [
    {
      type: 'application/ld+json',
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'Auction24.cz',
        url: `${origin}/`,
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${origin}/search/{search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      }),
    },
  ],
})

const { items, total, page, pageSize, pending } = usePagedItems({ endpoint: '/api/items', key: 'items:home' })

useItemListLd(items)
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <h1 class="app-h1 home-heading">
        {{ t('seo.homeTitle') }}
      </h1>
      <ItemsListing
        v-model:page="page"
        :items="items"
        :total="total"
        :page-size="pageSize"
        :pending="pending"
        :show-count="false"
      />
    </div>
  </section>

  <section class="band band-light">
    <div class="app-container">
      <h2 class="app-h1 band-title">
        {{ t('categories') }}
      </h2>
      <CategoriesGrid />
    </div>
  </section>

  <div class="app-container band">
    <RecommendedItems />
  </div>

  <section class="band band-light">
    <div class="app-container">
      <HowItWorks />
    </div>
  </section>

  <section class="band">
    <div class="app-container">
      <ContactForm />
    </div>
  </section>
</template>

<style scoped>
.home-heading {
  @apply mb-6;
}

.band {
  @apply py-8 md:py-16;
}

.band-light {
  @apply bg-app-surface;
}

.band-title {
  @apply mb-8 text-center;
}
</style>
