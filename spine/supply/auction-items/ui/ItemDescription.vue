<script setup lang="ts">
import type { Item } from '~/models'
import { ItemType, contentLocaleKey } from '~/models'

const props = defineProps<{ item: Item }>()

const { t, locale } = useI18n()

// Most items only have the source-locale (cz) description filled, so fall back
// active locale → cz → en → first non-empty rather than showing an empty panel.
const description = computed(() => {
  const d = props.item.description
  const raw = d[contentLocaleKey(locale.value)] || d.cz || d.en || Object.values(d).find(Boolean) || ''
  return raw.replace('\n\r', '<br>')
})
</script>

<template>
  <div v-if="description || ((item.email || item.phone) && item.type === ItemType.auction)" class="app-panel panel">
    <div class="app-panel-heading">
      {{ t('itemDescription') }}
    </div>
    <div class="app-panel-body">
      <div class="body-text">
        {{ description }}
      </div>
      <ItemContact v-if="item.type === ItemType.auction" :item="item" class="contact" />
    </div>
  </div>
</template>

<style scoped>
.panel {
  @apply mt-4;
}

.body-text {
  @apply whitespace-pre-line;
}

.contact {
  @apply pt-1;
}
</style>
