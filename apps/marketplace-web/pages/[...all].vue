<script setup lang="ts">
const { t } = useI18n()
useSeo({ title: () => t('not-found'), noindex: true })

// Return a real 404 to crawlers instead of a soft 404 (HTTP 200) — the page still renders.
const event = useRequestEvent()
if (event) setResponseStatus(event, 404)
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <div class="not-found">
        <h1 class="app-h1">404</h1>
        <p class="message">
          {{ t('not-found') }}
        </p>
        <NuxtLinkLocale to="/" class="app-text-btn home-link"> Auction24.cz </NuxtLinkLocale>
      </div>
    </div>
  </section>
</template>

<style scoped>
.not-found {
  @apply py-16 text-center;
}

.message {
  @apply mt-4 text-gray-500;
}

.home-link {
  @apply mt-6 inline-block;
}
</style>
