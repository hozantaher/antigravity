<script lang="ts" setup>
import { savedSearchFilterCount } from '~/models'
import type { SavedSearch } from '~/models'

const props = defineProps<{ search: SavedSearch }>()

const { t } = useI18n()
const { remove, toggleAlert } = useSavedSearches()

const filterCount = computed(() => savedSearchFilterCount(props.search.query))

const onToggle = () => toggleAlert(props.search.id, !props.search.alertEnabled)
const onRemove = () => remove(props.search.id)
</script>

<template>
  <li class="card">
    <div class="info">
      <span class="name">{{ search.name }}</span>
      <span class="summary">{{ t('savedSearch.filterSummary', { count: filterCount }) }}</span>
    </div>
    <div class="actions">
      <button
        type="button"
        class="alert-toggle"
        :class="{ 'is-on': search.alertEnabled }"
        :title="search.alertEnabled ? t('savedSearch.alertOn') : t('savedSearch.alertOff')"
        :aria-label="search.alertEnabled ? t('savedSearch.alertOn') : t('savedSearch.alertOff')"
        @click="onToggle"
      >
        <Icon :name="search.alertEnabled ? 'heroicons-solid:bell' : 'heroicons-outline:bell-slash'" class="bell" />
      </button>
      <BaseConfirmation :subheading="t('savedSearch.deleteConfirm')" @on-confirm="onRemove">
        <button type="button" class="delete-btn" :aria-label="t('savedSearch.delete')">
          <Icon name="heroicons-outline:trash" class="trash" />
        </button>
      </BaseConfirmation>
    </div>
  </li>
</template>

<style scoped>
.card {
  @apply flex items-center justify-between gap-4 border border-app-border bg-app-surface px-4 py-3 rounded-lg;
}

.info {
  @apply flex min-w-0 flex-col gap-1;
}

.name {
  @apply truncate text-sm font-medium text-app-text-strong;
}

.summary {
  @apply text-xs text-app-text-muted;
}

.actions {
  @apply flex flex-shrink-0 items-center gap-2;
}

.alert-toggle {
  @apply flex items-center justify-center rounded-full border border-app-border p-2 text-app-text-muted;

  &.is-on {
    @apply border-app-amber text-app-amber;
  }
}

.bell {
  @apply h-5 w-5;
}

.delete-btn {
  @apply flex items-center justify-center rounded-full border border-app-border p-2 text-app-text-muted hover:text-app-primary;
}

.trash {
  @apply h-5 w-5;
}
</style>
