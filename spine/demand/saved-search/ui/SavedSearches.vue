<script lang="ts" setup>
const { t } = useI18n()
const { items, total, page, pageSize, loading, fetchPage } = useSavedSearches()

onMounted(() => fetchPage(1))
watch(page, p => fetchPage(p))
</script>

<template>
  <section class="saved-searches">
    <div class="intro">
      <h3 class="intro-title">{{ t('savedSearch.title') }}</h3>
      <p class="intro-desc">{{ t('savedSearch.alertHint') }}</p>
    </div>

    <p v-if="!loading && total === 0" class="empty">{{ t('savedSearch.empty') }}</p>

    <ul v-else class="card-list">
      <SavedSearchCard v-for="s in items" :key="s.id" :search="s" />
    </ul>

    <BasePagination v-if="total > pageSize" v-model:page="page" :total="total" :page-size="pageSize" />
  </section>
</template>

<style scoped>
.saved-searches {
  @apply mt-8 space-y-4;
}

.intro {
  @apply space-y-1;
}

.intro-title {
  @apply text-lg leading-6 font-medium text-app-text-strong;
}

.intro-desc {
  @apply max-w-2xl text-sm text-app-text-muted;
}

.empty {
  @apply rounded-lg border border-app-border bg-app-surface-muted px-4 py-6 text-center text-sm text-app-text-muted;
}

.card-list {
  @apply space-y-3;
}
</style>
