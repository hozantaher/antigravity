<script setup lang="ts">
// The list inside the bell drawer: mark-all-read action, the rows, an empty state, and load-more.
// Lives behind the drawer so it only fetches when first opened (loaded guard) — cheap on the badge.
const emit = defineEmits(['navigate'])

const { t } = useI18n()
const { items, unread, loading, loaded, hasMore, refresh, loadMore, markAllRead } = useNotifications()

onMounted((): void => {
  if (!loaded.value) refresh()
})
</script>

<template>
  <div class="feed">
    <div class="feed-head">
      <button type="button" class="app-text-btn mark-all" :disabled="unread === 0" @click="markAllRead">
        {{ t('notifications.markAllRead') }}
      </button>
    </div>

    <ul v-if="items.length" class="feed-list">
      <li v-for="n in items" :key="n.id">
        <NotificationItem :notification="n" @navigate="emit('navigate')" />
      </li>
    </ul>

    <div v-else-if="loaded && !loading" class="feed-empty">
      <Icon name="heroicons-outline:bell" class="empty-icon" aria-hidden="true" />
      <p class="empty-text">{{ t('notifications.empty') }}</p>
    </div>

    <div v-else class="feed-loading">
      <Icon name="mdi:loading" class="spinner" aria-hidden="true" />
    </div>

    <div v-if="hasMore" class="feed-more">
      <button type="button" class="app-btn-alt load-more" :disabled="loading" @click="loadMore">
        {{ t('notifications.loadMore') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.feed {
  @apply flex h-full flex-col;
}

.feed-head {
  @apply flex justify-end px-4 py-2;
}

.mark-all {
  @apply cursor-pointer disabled:cursor-not-allowed disabled:opacity-40;
}

.feed-list {
  @apply flex-1;
}

.feed-empty {
  @apply flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-app-text-muted;
}

.empty-icon {
  @apply h-10 w-10;
}

.empty-text {
  @apply text-sm;
}

.feed-loading {
  @apply flex flex-1 items-center justify-center py-12;
}

.spinner {
  @apply h-6 w-6 animate-spin text-app-text-muted;
}

.feed-more {
  @apply p-4;
}
</style>
