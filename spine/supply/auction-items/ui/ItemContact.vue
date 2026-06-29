<script lang="ts" setup>
import type { Item } from '~/models'

defineProps<{
  item: Item
}>()
</script>

<template>
  <div class="contact">
    <a class="contact-link" :href="`mailto:${item.email}?subject=${item.title}`" target="_blank">{{ item.email }}</a>
    <span v-if="item.email && item.phone">|</span>
    <a class="contact-link" :href="`tel:${item.phone}`"> {{ item.phone }}</a>
  </div>
</template>

<style scoped>
.contact {
  @apply flex items-center gap-2;
}

.contact-link {
  @apply text-app-primary hover:underline;
}
</style>
