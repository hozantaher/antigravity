<script lang="ts" setup>
// Generic "nothing here yet" by default; on a search/filtered surface (searchContext) it switches to
// the result-oriented copy ("no matching listings — try broadening"), which reads better when the
// emptiness is the user's filter, not an empty catalogue.
const props = defineProps<{ searchContext?: boolean }>()
const { t } = useI18n()

const title = computed((): string => (props.searchContext ? t('search.noResults') : t('noItems')))
const desc = computed((): string => (props.searchContext ? t('search.noResultsHint') : t('noItemsDesc')))
</script>

<template>
  <div class="empty">
    <Icon name="heroicons-outline:search-circle" class="empty-icon" />
    <h3 class="empty-title">
      {{ title }}
    </h3>
    <p class="empty-desc">
      {{ desc }}
    </p>
  </div>
</template>

<style scoped>
.empty {
  @apply text-center;
}

.empty-icon {
  @apply mx-auto h-12 w-12 text-app-text-muted;
}

.empty-title {
  @apply mt-2 font-medium text-app-text-strong;
}

.empty-desc {
  @apply mt-1 text-app-text-muted;
}
</style>
