<script setup lang="ts">
// 360° panorama still. auction24 used a vendored PanoLens build; here we render a
// static equirectangular frame with a hover overlay. Wire @egjs/vue3-view360 here
// for the interactive viewer.
interface Props {
  source?: string
  type?: string
  itemId?: string
}

const props = withDefaults(defineProps<Props>(), {
  source: '',
  type: 'image',
})

const { t } = useI18n()
const { getImageUrl } = useImageProcessing()

const showBackdrop = ref(true)

// pano_360_interact (§3.4): each reveal of the 360° frame is a deep-inspection signal.
const tracking = useTracking()
let interactions = 0
const onEnter = () => {
  showBackdrop.value = false
  interactions++
}
onScopeDispose(() => interactions > 0 && props.itemId && tracking.pano(props.itemId, interactions))
</script>

<template>
  <div class="pano" @mouseenter="onEnter" @mouseleave="showBackdrop = true">
    <div v-if="showBackdrop" class="overlay">
      <div class="label">
        <span>360</span>
        <Icon name="mdi:rotate-360" class="label-icon" />
      </div>
    </div>
    <img v-if="source" :src="getImageUrl(source, { width: 1280 })" class="image" :alt="t('panorama')" loading="lazy" />
    <div v-else class="fallback" />
  </div>
</template>

<style scoped>
.pano {
  @apply relative aspect-2-1 w-full border-0 p-0;
}

.overlay {
  @apply pointer-events-none absolute z-1 flex h-full w-full items-center justify-center backdrop-dim;
}

.label {
  @apply text-center text-32 text-white;
}

.label-icon {
  @apply text-32 text-white;
}

.image {
  @apply h-full w-full object-cover;
}

.fallback {
  @apply h-full w-full bg-gray-800;
}
</style>
