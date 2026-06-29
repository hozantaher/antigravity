<script lang="ts" setup>
import type { Item } from '~/models'
import { ItemStatus } from '~/models'

const props = defineProps<{
  item: Item
  compact?: boolean
  showDate?: boolean
  inline?: boolean
}>()

const { t } = useI18n()

const mounted = useMounted()

// Status re-derived every second from the one shared ticker, not a per-instance interval.
const { now, status } = useLiveItemStatus(() => props.item)

// Countdown stays empty until mounted: a server-rendered time drifts from the client by the
// render delay → hydration text mismatch. Gating on `mounted` keeps SSR output stable.
const remaining = computed(() => {
  if (!mounted.value || props.compact) return ''
  void now.value
  if (([ItemStatus.BuyNow, ItemStatus.Sold, ItemStatus.AuctionEnd] as ItemStatus[]).includes(status.value)) return ''
  return remainingTime(status.value === ItemStatus.AuctionSoon ? props.item.startDate! : props.item.endDate!)
})

defineExpose({ status, remaining })
</script>

<template>
  <div>
    <div
      v-if="([ItemStatus.Sold, ItemStatus.AuctionEnd, ItemStatus.AuctionProcessing] as ItemStatus[]).includes(status)"
      class="state-ended"
    >
      <span class="badge badge-ended">
        {{ status === ItemStatus.Sold ? t('soldLabel') : t('infoEnded') }}
      </span>
    </div>
    <div v-if="status === ItemStatus.BuyNow">
      <span class="badge badge-buynow">
        {{ t('itemStatus.buyNow') }}
      </span>
    </div>
    <div v-if="status === ItemStatus.AuctionLive" class="state state-live" :class="{ 'is-inline': inline }">
      <span class="badge badge-live">
        {{ t('itemStatus.auctionLive') }}
      </span>
      <div v-if="!compact" class="detail">
        <div class="timer">
          <Icon name="heroicons-outline:clock" class="timer-icon" />
          {{ remaining }}
        </div>
        <div v-if="showDate" class="date">
          {{ formatDate(item.endDate!, 'DD.MM.yyyy HH:mm') }}
        </div>
      </div>
    </div>
    <div v-if="status === ItemStatus.AuctionSoon" class="state state-soon" :class="{ 'is-inline': inline }">
      <span class="badge badge-soon">
        {{ t('itemStatus.auctionSoon') }}
      </span>
      <div v-if="!compact" class="detail">
        <div class="timer timer-center">
          <Icon name="heroicons-outline:clock" class="timer-icon" />
          {{ remaining }}
        </div>
        <div v-if="showDate" class="date">
          {{ formatDate(item.startDate!, 'DD.MM.yyyy HH:mm') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.state {
  &.is-inline {
    @apply flex gap-2;
  }
}

.state-ended {
  @apply text-app-text-muted;
}

.state-live {
  @apply text-app-red;
}

.state-soon {
  @apply text-app-amber;
}

.badge {
  @apply inline-flex items-center px-3 py-0.5 rounded-full text-xs font-medium whitespace-nowrap md:text-sm;
}

.badge-ended {
  @apply bg-app-surface-muted text-app-text-muted uppercase;
}

.badge-buynow {
  @apply bg-app-green/10 text-app-green uppercase;
}

.badge-live {
  @apply bg-app-red/10 text-app-red;
}

.badge-soon {
  @apply bg-app-amber/10 text-app-amber;
}

.detail {
  @apply text-left;
}

.timer {
  @apply mt-0.5 flex items-center text-xs sm:text-sm;
}

.timer-center {
  @apply justify-center;
}

.timer-icon {
  @apply mr-1;
}

.date {
  @apply text-xs text-app-text-muted;
}
</style>
