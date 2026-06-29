<script lang="ts" setup>
const props = defineProps<{ categoryId: string }>()
const { t } = useI18n()
const { findCategory } = useCategories()

const category = findCategory(props.categoryId)

if (!category) throw createError({ statusCode: 404, statusMessage: 'Category not found' })

useSeo({
  title: () => t(`${category.id}Category`),
  description: () => t('seo.categoryDescription', { category: t(`${category.id}Category`) }),
})

const breadcrumbs = computed<{ label: string; to?: string }[]>(() => [
  { label: t('seo.home'), to: '/' },
  { label: t(`${category!.id}Category`) },
])

const { items, total, page, pageSize, pending } = usePagedItems({
  endpoint: '/api/items',
  query: () => ({ categoryId: props.categoryId }),
  key: 'items:category',
})

useItemListLd(items)
</script>

<template>
  <section v-if="category" class="app-section">
    <div class="app-container">
      <BaseBreadcrumb :items="breadcrumbs" />
      <h1 class="app-h1">
        {{ t(`${category!.id}Category`) }}
      </h1>
      <main class="results">
        <ItemsListing
          v-model:page="page"
          :items="items"
          :total="total"
          :page-size="pageSize"
          :pending="pending"
          :save-query="{ categoryId }"
        />
      </main>
    </div>
  </section>

  <section class="contact-section">
    <div class="app-container">
      <ContactForm />
    </div>
  </section>
</template>

<style scoped>
.results {
  @apply py-8;
}

.contact-section {
  @apply bg-app-surface py-8 md:py-16;
}
</style>
