<script lang="ts" setup>
import { itemSignalMeta, type Item } from '~/models'

// Lazy: the lightbox pulls in the HeadlessUI Dialog + swipe/keystroke logic. Loading it only
// on first open keeps that chunk off the item-detail critical path.
const ItemLightbox = defineAsyncComponent(() => import('./ItemLightbox.vue'))

const props = defineProps<{
  item: Item
}>()

const { t } = useI18n()
const { imgUrl, dprSrcset, fallbackUrl } = useImageProcessing()

const images = computed(() => [props.item.image, ...props.item.images].filter(Boolean))
const activeIndex = ref(0)

// photo_view (§3.4): count distinct photos the visitor actually looked at, emitted on leave.
const tracking = useTracking()
const seenPhotos = new Set<number>()
watch(activeIndex, i => seenPhotos.add(i), { immediate: true })
onScopeDispose(
  () => seenPhotos.size > 0 && tracking.photoView(props.item.id, seenPhotos.size, itemSignalMeta(props.item)),
)
const lightboxOpen = ref(false)
// Mounts on first open and stays mounted so HeadlessUI's leave transition still plays on close.
const lightboxMounted = ref(false)
const hasThumbs = computed(() => images.value.length > 1)
const countLabel = computed(() => `${activeIndex.value + 1} / ${images.value.length}`)
const heroSrc = computed(() => imgUrl(images.value[activeIndex.value] ?? '', '800x600'))
const heroSrcset = computed(() => dprSrcset(images.value[activeIndex.value] ?? '', '800x600'))
const heroFallback = computed(() => fallbackUrl(images.value[activeIndex.value] ?? '', { width: 800, height: 600 }))

const openLightbox = () => {
  lightboxMounted.value = true
  lightboxOpen.value = true
}

// Desktop-only scroll affordance for the thumbnail strip (mobile uses native touch scroll).
const { track, canLeft, canRight, updateArrows, scrollByPage } = useScrollArrows()
onMounted(updateArrows)

watch(activeIndex, async () => {
  await nextTick()
  const thumb = track.value?.children[activeIndex.value] as HTMLElement | undefined
  thumb?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  updateArrows()
})
</script>

<template>
  <div class="gallery">
    <FlagBadge :country-code="item.countryCode" />
    <button type="button" class="hero" :aria-label="t('galleryViewAll')" @click="openLightbox">
      <BaseImage
        :src="heroSrc"
        :srcset="heroSrcset"
        :fallback="heroFallback"
        :alt="item.title"
        class="hero-img"
        width="800"
        height="600"
        fetchpriority="high"
        decoding="async"
      />
      <span class="hero-overlay">
        <span class="expand">
          <Icon name="heroicons-outline:arrows-expand" class="expand-icon" />
        </span>
        <span v-if="hasThumbs" class="count">
          <Icon name="heroicons-solid:camera" class="count-icon" />
          {{ countLabel }}
        </span>
      </span>
    </button>

    <div v-if="hasThumbs" class="strip">
      <button
        type="button"
        class="strip-arrow strip-arrow-prev"
        :class="{ 'is-hidden': !canLeft }"
        :aria-label="t('galleryPrevious')"
        @click="scrollByPage(-1)"
      >
        <Icon name="heroicons-outline:chevron-left" class="strip-arrow-icon" />
      </button>

      <div ref="track" class="strip-track">
        <button
          v-for="(image, i) in images"
          :key="image"
          type="button"
          class="strip-thumb"
          :class="{ 'is-active': i === activeIndex }"
          :aria-label="t('galleryPhotoOf', { current: i + 1, total: images.length })"
          :aria-current="i === activeIndex ? 'true' : undefined"
          @click="activeIndex = i"
        >
          <BaseImage
            :src="imgUrl(image, '192x144')"
            :fallback="fallbackUrl(image, { width: 192, height: 144 })"
            :alt="''"
            class="strip-img"
            loading="lazy"
            decoding="async"
          />
        </button>
      </div>

      <button
        type="button"
        class="strip-arrow strip-arrow-next"
        :class="{ 'is-hidden': !canRight }"
        :aria-label="t('galleryNext')"
        @click="scrollByPage(1)"
      >
        <Icon name="heroicons-outline:chevron-right" class="strip-arrow-icon" />
      </button>
    </div>

    <ClientOnly>
      <ItemLightbox
        v-if="lightboxMounted"
        v-model:open="lightboxOpen"
        v-model:index="activeIndex"
        :images="images"
        :title="item.title"
        :item-id="item.id"
      />
    </ClientOnly>
  </div>
</template>

<style scoped>
.gallery {
  @apply relative w-full;
}

.hero {
  @apply relative block w-full cursor-pointer overflow-hidden rounded-lg border-0 bg-app-surface-muted p-0;
}

.hero-img {
  @apply aspect-4-3 w-full object-cover object-center transition-transform duration-300;
}

.hero:hover .hero-img {
  @apply scale-105;
}

.hero-overlay {
  @apply pointer-events-none absolute inset-0;
}

.expand {
  @apply absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white;
}

.expand-icon {
  @apply h-5 w-5;
}

.count {
  @apply absolute right-3 bottom-3 inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-sm font-medium text-white;
}

.count-icon {
  @apply h-4 w-4;
}

.strip {
  @apply relative mt-2;
}

.strip-track {
  @apply flex gap-2 overflow-x-auto scroll-smooth;
}

.strip-thumb {
  @apply aspect-4-3 w-24 shrink-0 cursor-pointer overflow-hidden rounded-lg border-0 p-0 ring-1 ring-app-border transition-shadow duration-150;

  &:hover {
    @apply ring-app-border-strong;
  }

  &.is-active {
    @apply ring-2 ring-app-primary;
  }
}

.strip-img {
  @apply h-full w-full object-cover;
}

.strip-arrow {
  @apply absolute top-1/2 z-1 hidden h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-app-surface text-app-text-muted shadow-md md:flex;

  &:hover {
    @apply text-app-primary;
  }

  &.is-hidden {
    @apply md:hidden;
  }
}

.strip-arrow-prev {
  @apply left-1;
}

.strip-arrow-next {
  @apply right-1;
}

.strip-arrow-icon {
  @apply h-5 w-5;
}
</style>
