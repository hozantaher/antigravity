<script lang="ts" setup>
const { t } = useI18n()
useSeo({ title: () => t('buyNow'), description: () => t('seo.buyNowDescription') })

const { items, total, page, pageSize, pending } = usePagedItems({
  endpoint: '/api/items',
  query: () => ({ type: 'ad' }),
  key: 'items:ads',
})

useItemListLd(items)
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <h1 class="app-h1">
        {{ t('buyNow') }}
      </h1>
      <main class="body">
        <ItemsListing
          v-model:page="page"
          :items="items"
          :total="total"
          :page-size="pageSize"
          :pending="pending"
          :save-query="{ type: 'ad' }"
        />
      </main>
    </div>
  </section>
</template>

<style scoped>
.body {
  @apply py-8;
}
</style>
