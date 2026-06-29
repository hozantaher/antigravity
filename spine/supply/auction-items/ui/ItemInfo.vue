<script lang="ts" setup>
import { ItemType } from '~/models'
import type { Item } from '~/models'

defineProps<{ item: Item }>()

const { t } = useI18n()
</script>

<template>
  <div class="wrap">
    <div class="panel app-panel">
      <div class="body app-panel-body">
        <div class="icon-box" :class="{ 'is-auction': item.type === ItemType.auction }">
          <Icon name="heroicons-outline:currency-euro" class="icon" />
        </div>
        <div class="price-box">
          <p class="price-label">
            {{ t('bidContainerTitle') }}
          </p>
          <p class="price-value">
            {{ itemCurrentPrice(item)?.amount ? formatPrice(itemCurrentPrice(item)) : t('onRequest').toUpperCase() }}
          </p>
        </div>
        <ItemStatus :key="item.id" :item="item" show-date class="status-wide" inline />
        <ItemStatus :key="`${item.id}-xl`" :item="item" show-date class="status-narrow" />
      </div>
      <PriceStatus :key="item.id" :item="item" class="price-status app-panel-body" />
    </div>
  </div>
</template>

<style scoped>
.wrap {
  @apply w-full;
}

.panel {
  @apply flex flex-col overflow-hidden !px-0;
}

.body {
  @apply flex items-end gap-4 px-4;
}

.icon-box {
  @apply max-h-56 max-w-14 rounded-lg bg-app-green p-3;

  &.is-auction {
    @apply bg-app-red;
  }
}

.icon {
  @apply text-32 text-white;
}

.price-box {
  @apply flex flex-col justify-start;
}

.price-label {
  @apply truncate text-sm font-medium text-app-text-muted;
}

.price-value {
  @apply text-2xl font-semibold whitespace-nowrap text-app-text-strong;
}

.status-wide {
  @apply hidden xl:block;
}

.status-narrow {
  @apply xl:hidden;
}

.price-status {
  @apply !py-0;
}
</style>
