<script lang="ts" setup>
import type { Item } from '~/models'

withDefaults(
  defineProps<{
    items: Item[] | undefined
    total: number
    pageSize: number
    pending?: boolean
    showCount?: boolean
  }>(),
  { pending: false, showCount: true },
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
    <ItemsGridSkeletor v-if="items === undefined" />
    <NoItems v-else-if="!items.length" />
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
