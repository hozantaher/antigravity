<script lang="ts" setup>
const props = defineProps<{ q: string }>()
const { t } = useI18n()

// Same shared facet state the SearchFilters/SearchResults bind to, so the save button persists the
// exact query the user is browsing with.
const { searchQuery } = useSearchFilters({ q: () => props.q })

useSeo({ title: () => t('searchResult'), noindex: true })
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <div class="head">
        <h1 class="app-h1">
          {{ t('searchResult') }}
        </h1>
        <SaveSearchButton :query="searchQuery" />
      </div>
      <div class="layout">
        <SearchFilters class="layout-filters" />
        <main class="layout-results">
          <SearchResults :q="props.q" />
        </main>
      </div>
    </div>
  </section>

  <section class="contact-section">
    <div class="app-container">
      <ContactForm />
    </div>
  </section>
</template>

<style scoped>
.head {
  @apply flex flex-wrap items-center justify-between gap-4;
}

.layout {
  @apply flex flex-col gap-6 py-8 md:flex-row;
}

.layout-filters {
  @apply md:sticky md:top-4 md:w-72 md:shrink-0 md:self-start;
}

.layout-results {
  @apply min-w-0 flex-1;
}

.contact-section {
  @apply bg-app-surface py-8 md:py-16;
}
</style>
