<script setup lang="ts">
// Header bell + unread badge + the feed drawer. Owns the badge's freshness: refresh on login and a
// gentle 60s poll paused when the tab is hidden. Phase 0 polls; the SSE/web-push upgrade (Phase 2)
// will push these events instead of polling.
const { t } = useI18n()
const { isLogged } = useUser()
const { unread, refresh, reset } = useNotifications()

const open = ref(false)
const badge = computed((): string => (unread.value > 9 ? '9+' : String(unread.value)))

const POLL_MS = 60_000
const visibility = useDocumentVisibility()
const { pause, resume } = useIntervalFn(() => refresh(), POLL_MS, { immediate: false })

watch(
  isLogged,
  logged => {
    if (logged) {
      refresh()
      resume()
    } else {
      reset()
      pause()
    }
  },
  { immediate: true },
)

// Catch up the badge when the user returns to the tab; idle in the background.
watch(visibility, v => {
  if (!isLogged.value) return
  if (v === 'visible') {
    refresh()
    resume()
  } else {
    pause()
  }
})
</script>

<template>
  <div class="bell">
    <button type="button" class="app-icon-btn bell-btn" :aria-label="t('notifications.title')" @click="open = true">
      <Icon name="heroicons-outline:bell" class="bell-icon" aria-hidden="true" />
      <span v-if="unread > 0" class="bell-badge">{{ badge }}</span>
    </button>
    <BaseDrawer v-model:is-open="open" :heading="t('notifications.title')">
      <NotificationFeed @navigate="open = false" />
    </BaseDrawer>
  </div>
</template>

<style scoped>
.bell {
  @apply relative flex items-center;
}

.bell-btn {
  @apply relative p-1 hover:text-app-text;
}

.bell-icon {
  @apply h-6 w-6;
}

.bell-badge {
  @apply absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-app-primary px-1 text-xs font-semibold text-white;
}
</style>
