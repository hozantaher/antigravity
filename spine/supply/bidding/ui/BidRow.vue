<script lang="ts" setup>
import type { Bid } from '~/models'

const props = defineProps<{
  bid: Bid
  index: number
  isMine: boolean
  name: string
  to?: string
}>()

const initial = computed(() => props.name.trim().charAt(0).toUpperCase() || '?')

const nameState = computed(() => ({
  'is-mine': props.isMine && props.index !== 0,
  'is-mine-top': props.isMine && props.index === 0,
}))
const pillState = computed(() => ({
  'is-mine': props.isMine && props.index !== 0,
  'is-mine-top': props.isMine && props.index === 0,
}))
</script>

<template>
  <li class="bid-row">
    <div class="bid-line">
      <span class="avatar">
        <span class="avatar-initial">{{ initial }}</span>
      </span>
      <div class="bid-info">
        <NuxtLinkLocale v-if="to" :to="to" target="_blank">
          <p class="bid-name app-text-btn-admin" :class="nameState">
            {{ name }}
          </p>
        </NuxtLinkLocale>
        <p v-else class="bid-name" :class="nameState">
          {{ name }}
        </p>
        <p class="bid-date">
          {{ formatDate(bid.date, 'DD.MM.yyyy HH:mm') }}
        </p>
      </div>
      <div>
        <span class="bid-pill" :class="pillState">
          <Icon name="heroicons-outline:hand" class="bid-pill-icon" />
          {{ formatPrice(bid) }}
        </span>
      </div>
    </div>
  </li>
</template>

<style scoped>
.bid-row {
  @apply py-4;
}

.bid-line {
  @apply flex items-center space-x-4;
}

.avatar {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-500;
}

.avatar-initial {
  @apply text-sm font-medium leading-none text-white;
}

.bid-info {
  @apply min-w-0 flex-1;
}

.bid-name {
  @apply truncate text-sm font-medium text-app-text-strong;

  &.is-mine {
    @apply !text-app-red;
  }

  &.is-mine-top {
    @apply !font-bold !text-app-green;
  }
}

.bid-date {
  @apply truncate text-sm text-app-text-muted;
}

.bid-pill {
  @apply inline-flex items-center rounded-full border border-app-border-strong bg-app-surface px-2.5 py-0.5 font-medium leading-5 text-app-text hover:bg-app-surface-muted;

  &.is-mine {
    @apply !bg-app-red !text-white;
  }

  &.is-mine-top {
    @apply !bg-app-green !text-white;
  }
}

.bid-pill-icon {
  @apply mr-1;
}
</style>
