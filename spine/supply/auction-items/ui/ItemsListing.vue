<script lang="ts" setup>
import type { Item, SearchQuery } from '~/models'

// saveQuery (when set) renders a "save this search / alert me" action above the list — available even
// on an empty result, which is the most valuable moment to set up an alert. searchContext switches the
// empty state to the result-oriented copy for search/filtered surfaces.
withDefaults(
  defineProps<{
    items: Item[] | undefined
    total: number
    pageSize: number
    pending?: boolean
    showCount?: boolean
    searchContext?: boolean
    saveQuery?: SearchQuery
  }>(),
  { pending: false, showCount: true, searchContext: false },
)

const page = defineModel<number>('page', { required: true })
const { t } = useI18n()
const root = ref<HTMLElement>()

// Jump back to the top of the list when the page changes (client-only).
watch(page, () => {
  if (import.meta.client) root.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
})
</script>

<template>
  <div ref="root" class="listing">
    <div v-if="saveQuery" class="listing-actions">
      <SaveSearchButton :query="saveQuery" />
    </div>
    <ItemsGridSkeletor v-if="items === undefined" />
    <NoItems v-else-if="!items.length" :search-context="searchContext" />
    <template v-else>
      <p v-if="showCount" class="count">{{ t('numberOfItems') }}: {{ total }}</p>
      <div class="frame" :class="{ 'is-loading': pending }">
        <ItemsGrid :items="items" />
      </div>
      <BasePagination v-model:page="page" :total="total" :page-size="pageSize" />
    </template>
  </div>
</template>

<style scoped>
.listing-actions {
  @apply mb-4 flex justify-end;
}

.count {
  @apply mb-2 text-lg;
}

.frame {
  @apply transition-opacity duration-200;

  &.is-loading {
    @apply pointer-events-none opacity-60;
  }
}
</style>
