<script lang="ts" setup>
const { t } = useI18n()
useSeo({ title: () => t('sold'), description: () => t('seo.soldDescription') })

const { items, total, page, pageSize, pending } = usePagedItems({ endpoint: '/api/items/sold', key: 'items:sold' })

useItemListLd(items)
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <h1 class="app-h1">
        {{ t('sold') }}
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
