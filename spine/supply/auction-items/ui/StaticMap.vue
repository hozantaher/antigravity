<script setup lang="ts">
import type { Gps } from '~/models'

// Mock backend: Google Maps is replaced by a keyless OpenStreetMap embed.
const props = defineProps<{
  gps: Gps
}>()

const { t } = useI18n()

const src = computed(() => {
  const { lat, lng } = props.gps
  const d = 0.01
  const bbox = `${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}`
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`
})
</script>

<template>
  <iframe :src="src" :title="t('vehicleLocation')" class="map-frame" loading="lazy" referrerpolicy="no-referrer" />
</template>

<style scoped>
.map-frame {
  @apply h-full w-full border-0;
}
</style>
