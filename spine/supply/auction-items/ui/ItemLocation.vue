<script lang="ts" setup>
import type { Item } from '~/models'

defineProps<{
  item: Item
}>()

const { findCountryByCode2 } = useCountries()
</script>

<template>
  <div v-if="item.location || item.countryCode" class="location">
    <Icon name="heroicons-outline:location-marker" />
    <span>{{ item.location ?? findCountryByCode2(item.countryCode!)?.name }}</span>
    <Icon v-if="item.countryCode" :name="`flag:${item.countryCode}-4x3`" class="flag" />
  </div>
</template>

<style scoped>
.location {
  @apply flex items-center gap-2 text-app-text-muted;
}

.flag {
  @apply text-18 h-4 w-5.5;
}
</style>
