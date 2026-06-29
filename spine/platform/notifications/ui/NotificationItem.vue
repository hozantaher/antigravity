<script setup lang="ts">
import type { Notification } from '~/models'

// One row in the feed. Maps the three event types to a semantic icon, shows the listing title + when,
// and on click marks itself read and deep-links to the item (win/outbid/answer all concern a lot).
const props = defineProps<{ notification: Notification }>()
const emit = defineEmits(['navigate'])

const { t } = useI18n()
const localePath = useLocalePath()
const { markRead } = useNotifications()

const ICONS: Record<Notification['type'], string> = {
  win: 'heroicons-outline:badge-check',
  outbid: 'heroicons-outline:lightning-bolt',
  answer: 'heroicons-outline:chat-bubble-left-right',
}

const isUnread = computed((): boolean => props.notification.readAt == null)
const icon = computed((): string => ICONS[props.notification.type])
const message = computed((): string =>
  t(`notifications.type.${props.notification.type}`, { title: props.notification.title }),
)

const activate = async (): Promise<void> => {
  await markRead(props.notification.id)
  if (props.notification.itemId) await navigateTo(localePath(`/item/${props.notification.itemId}`))
  emit('navigate')
}
</script>

<template>
  <button
    type="button"
    class="notif-row"
    :class="[`is-${notification.type}`, { 'is-unread': isUnread }]"
    @click="activate"
  >
    <span class="notif-icon">
      <Icon :name="icon" class="icon" aria-hidden="true" />
    </span>
    <span class="notif-main">
      <span class="notif-message">{{ message }}</span>
      <span class="notif-time">{{ formatDate(notification.created, 'DD.MM.yyyy HH:mm') }}</span>
    </span>
    <span v-if="isUnread" class="notif-dot" aria-hidden="true" />
  </button>
</template>

<style scoped>
.notif-row {
  @apply flex w-full cursor-pointer items-start gap-3 border-b border-app-border px-4 py-3 text-left hover:bg-app-surface-muted;

  &.is-unread {
    @apply bg-app-primary/5;
  }
}

.notif-icon {
  @apply mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-app-surface-muted;

  .is-win & {
    @apply text-app-green;
  }

  .is-outbid & {
    @apply text-app-red;
  }

  .is-answer & {
    @apply text-app-primary;
  }
}

.icon {
  @apply h-5 w-5;
}

.notif-main {
  @apply flex min-w-0 flex-1 flex-col;
}

.notif-message {
  @apply text-sm text-app-text;
}

.notif-time {
  @apply mt-1 text-xs text-app-text-muted;
}

.notif-dot {
  @apply mt-2 h-2 w-2 shrink-0 rounded-full bg-app-primary;
}
</style>
