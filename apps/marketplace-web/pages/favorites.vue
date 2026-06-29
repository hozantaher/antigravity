<script lang="ts" setup>
const { t } = useI18n()

useSeo({ title: () => t('favorite'), noindex: true })

const { user } = useUser()
const { items, total, page, pageSize, pending, refresh } = usePagedItems({
  endpoint: '/api/favorites',
  server: false,
  key: 'items:favorites',
})

// Unfavoriting from a card shrinks favoriteIds — reload the current page.
watch(
  () => user.value?.favoriteIds.length,
  () => refresh(),
)
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <h1 class="app-h1">
        {{ t('favorite') }}
      </h1>
      <main class="body">
        <ItemsListing v-model:page="page" :items="items" :total="total" :page-size="pageSize" :pending="pending" />
      </main>
    </div>
  </section>
</template>

<style scoped>
.body {
  @apply py-8;
}
</style>
