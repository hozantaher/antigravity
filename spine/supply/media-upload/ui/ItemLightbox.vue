<script lang="ts" setup>
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from '@headlessui/vue'
import { wrapIndex } from '~/features/supply/media-upload/logic/galleryNav'

const props = defineProps<{
  images: string[]
  title: string
  index: number
  open: boolean
  itemId?: string
}>()

const emit = defineEmits<{
  'update:index': [value: number]
  'update:open': [value: boolean]
}>()

const { t } = useI18n()
const { imgUrl, getImageUrl, widthSrcset } = useImageProcessing()

// Full-screen view: width-only resize keeps aspect for both landscape photos and 2:1 panos.
// src is the fallback/preload pick; the displayed <img> chooses from srcset by viewport+DPR,
// so phones no longer download the 1920 desktop image.
const fullSrc = (url: string) => getImageUrl(url, { width: 1280 })
const fullSrcset = (url: string) => widthSrcset(url, [768, 1280, 1920])

const hasMany = computed(() => props.images.length > 1)
const currentSrc = computed(() => fullSrc(props.images[props.index] ?? ''))
const currentSrcset = computed(() => fullSrcset(props.images[props.index] ?? ''))
const counterText = computed(() => `${props.index + 1} / ${props.images.length}`)

const reducedMotion = usePreferredReducedMotion()
const motionOk = computed(() => reducedMotion.value !== 'reduce')

const close = () => emit('update:open', false)
const go = (delta: number) => emit('update:index', wrapIndex(props.index, props.images.length, delta))
const prev = () => go(-1)
const next = () => go(1)

// Zoom with cursor-follow pan; touch simply gets a centred 1.5× zoom.
const isZoomed = ref(false)
const origin = ref('center')
// photo_zoom (§3.4): deep-inspection signal — count zoom activations, emit on close.
const tracking = useTracking()
let zoomCount = 0
const toggleZoom = () => {
  isZoomed.value = !isZoomed.value
  if (isZoomed.value) zoomCount++
  else origin.value = 'center'
}
onScopeDispose(() => zoomCount > 0 && props.itemId && tracking.photoZoom(props.itemId, zoomCount))
const onPointerMove = (e: PointerEvent) => {
  if (!isZoomed.value) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * 100
  const y = ((e.clientY - rect.top) / rect.height) * 100
  origin.value = `${x}% ${y}%`
}

// Spinner while the full-res image loads; img.complete avoids a flash on cached/preloaded ones.
const isLoading = ref(false)
watch(
  currentSrc,
  src => {
    if (!src) return
    isLoading.value = true
    const img = new Image()
    const done = () => {
      if (currentSrc.value === src) isLoading.value = false
    }
    img.onload = done
    img.onerror = done
    img.src = src
    if (img.complete) isLoading.value = false
  },
  { immediate: true },
)

// Preload neighbours so navigation feels instant.
watch(
  [() => props.index, () => props.open],
  () => {
    if (!props.open) return
    for (const delta of [-1, 1]) {
      const src = props.images[wrapIndex(props.index, props.images.length, delta)]
      if (src) new Image().src = fullSrc(src)
    }
  },
  { immediate: true },
)

// Reset zoom whenever the photo or the dialog visibility changes.
watch([() => props.index, () => props.open], () => {
  isZoomed.value = false
  origin.value = 'center'
})

const stage = ref<HTMLElement>()
const track = ref<HTMLElement>()
const closeBtn = ref<HTMLElement>()

useSwipe(stage, {
  threshold: 40,
  onSwipeEnd(_, direction) {
    if (!props.open || isZoomed.value) return
    if (direction === 'left') next()
    else if (direction === 'right') prev()
    else if (direction === 'down') close()
  },
})

onKeyStroke('ArrowLeft', e => {
  if (!props.open) return
  e.preventDefault()
  prev()
})
onKeyStroke('ArrowRight', e => {
  if (!props.open) return
  e.preventDefault()
  next()
})

// Keep the active filmstrip thumbnail scrolled into view.
watch([() => props.index, () => props.open], async () => {
  if (!props.open) return
  await nextTick()
  const thumb = track.value?.children[props.index] as HTMLElement | undefined
  thumb?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: motionOk.value ? 'smooth' : 'auto' })
})
</script>

<template>
  <TransitionRoot :show="open" as="template">
    <Dialog class="lightbox" :initial-focus="closeBtn" :aria-label="title" @close="close">
      <TransitionChild
        as="template"
        enter="ease-out duration-200"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="ease-in duration-150"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="overlay" aria-hidden="true" />
      </TransitionChild>

      <TransitionChild
        as="template"
        enter="ease-out duration-200"
        enter-from="opacity-0 scale-95"
        enter-to="opacity-100 scale-100"
        leave="ease-in duration-150"
        leave-from="opacity-100 scale-100"
        leave-to="opacity-0 scale-95"
      >
        <DialogPanel class="viewer">
          <div class="topbar">
            <p v-if="hasMany" class="counter">{{ counterText }}</p>
            <span v-else aria-hidden="true" />
            <div class="topbar-actions">
              <button
                type="button"
                class="ctrl"
                :aria-label="isZoomed ? t('galleryZoomOut') : t('galleryZoomIn')"
                @click="toggleZoom"
              >
                <Icon :name="isZoomed ? 'heroicons-outline:zoom-out' : 'heroicons-outline:zoom-in'" class="ctrl-icon" />
              </button>
              <button ref="closeBtn" type="button" class="ctrl" :aria-label="t('close')" @click="close">
                <Icon name="heroicons-outline:x" class="ctrl-icon" />
              </button>
            </div>
          </div>

          <div ref="stage" class="stage" @click.self="close" @pointermove="onPointerMove">
            <button
              v-if="hasMany"
              type="button"
              class="nav nav-prev"
              :aria-label="t('galleryPrevious')"
              @click.stop="prev"
            >
              <Icon name="heroicons-outline:chevron-left" class="nav-icon" />
            </button>

            <Transition :css="motionOk" name="fade" mode="out-in">
              <img
                :key="index"
                :src="currentSrc"
                :srcset="currentSrcset"
                sizes="100vw"
                :alt="t('galleryPhotoOf', { current: index + 1, total: images.length })"
                class="stage-image"
                :class="{ 'is-zoomed': isZoomed }"
                :style="{ transformOrigin: origin }"
                draggable="false"
                @click="toggleZoom"
              />
            </Transition>

            <div v-if="isLoading" class="spinner" aria-hidden="true">
              <Icon name="mdi:loading" class="spinner-icon" />
            </div>

            <button v-if="hasMany" type="button" class="nav nav-next" :aria-label="t('galleryNext')" @click.stop="next">
              <Icon name="heroicons-outline:chevron-right" class="nav-icon" />
            </button>
          </div>

          <div v-if="hasMany" ref="track" class="filmstrip">
            <button
              v-for="(image, i) in images"
              :key="image"
              type="button"
              class="filmstrip-thumb"
              :class="{ 'is-active': i === index }"
              :aria-label="t('galleryPhotoOf', { current: i + 1, total: images.length })"
              :aria-current="i === index ? 'true' : undefined"
              @click="emit('update:index', i)"
            >
              <img :src="imgUrl(image, '192x144')" :alt="''" class="filmstrip-img" loading="lazy" decoding="async" />
            </button>
          </div>
        </DialogPanel>
      </TransitionChild>
    </Dialog>
  </TransitionRoot>
</template>

<style scoped>
.lightbox {
  @apply relative z-50;
}

/* z-index lives on these plain divs (not on .lightbox): the HeadlessUI Dialog
   root is portaled and never receives this component's scoped style, so the
   overlay/viewer carry the stacking above the fixed header (z-10) + cookie bar. */
.overlay {
  @apply fixed inset-0 z-50 bg-black/90;
}

.viewer {
  @apply fixed inset-0 z-50 flex flex-col;
}

.topbar {
  @apply flex shrink-0 items-center justify-between p-4;
}

.counter {
  @apply rounded-full bg-black/40 px-3 py-1 text-sm font-medium tabular-nums text-white;
}

.topbar-actions {
  @apply flex items-center gap-2;
}

.ctrl {
  @apply flex cursor-pointer items-center justify-center rounded-full bg-white/10 p-2 text-white;

  &:hover {
    @apply bg-white/20;
  }

  &:focus-visible {
    @apply outline-none ring-2 ring-white/70;
  }
}

.ctrl-icon {
  @apply h-6 w-6;
}

.stage {
  @apply relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 sm:px-4;
}

.stage-image {
  @apply max-h-full max-w-full cursor-zoom-in rounded-lg object-contain transition-transform duration-200 select-none;

  &.is-zoomed {
    @apply scale-150 cursor-zoom-out;
  }
}

.nav {
  @apply absolute top-1/2 flex -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 p-2 text-white sm:p-3;

  &:hover {
    @apply bg-white/20;
  }

  &:focus-visible {
    @apply outline-none ring-2 ring-white/70;
  }
}

.nav-prev {
  @apply left-2 sm:left-4;
}

.nav-next {
  @apply right-2 sm:right-4;
}

.nav-icon {
  @apply h-7 w-7 sm:h-8 sm:w-8;
}

.spinner {
  @apply pointer-events-none absolute inset-0 flex items-center justify-center;
}

.spinner-icon {
  @apply h-10 w-10 animate-spin text-white;
}

.filmstrip {
  @apply flex shrink-0 gap-2 overflow-x-auto p-4;
}

.filmstrip-thumb {
  @apply aspect-4-3 w-20 shrink-0 cursor-pointer overflow-hidden rounded-lg opacity-50 transition-opacity duration-150;

  &:hover {
    @apply opacity-100;
  }

  &.is-active {
    @apply opacity-100 ring-2 ring-app-primary;
  }
}

.filmstrip-img {
  @apply h-full w-full object-cover;
}

.fade-enter-active,
.fade-leave-active {
  @apply transition-opacity duration-200;
}

.fade-enter-from,
.fade-leave-to {
  @apply opacity-0;
}

@media (prefers-reduced-motion: reduce) {
  .stage-image {
    @apply transition-none;
  }
}
</style>
