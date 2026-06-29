<script lang="ts" setup>
import { ItemType, type Item, type RecoSurface } from '~/models'

// Presentational recommendations rail, shared by the detail "Podobné inzeráty" and the homepage
// "Vybráno pro vás". Takes a ready item list, applies the within-session re-rank (§14, client-only),
// and renders a horizontal strip of equal-height ItemCards. Empty → renders nothing.
const props = defineProps<{ items: Item[]; title: string; surface: RecoSurface }>()

const { t } = useI18n()
const { getCardImage, dprSrcset } = useImageProcessing()
const { sessionAttrs } = useTracking()

const mounted = useMounted()
const ranked = computed(() =>
  mounted.value
    ? withinSessionReRank(
        props.items,
        i => ({ make: i.specs?.manufacturer, bodyType: i.bodyType, priceBand: priceBand(itemCurrentPrice(i)?.amount) }),
        sessionAttrs(),
        RECO_CONFIG.withinSessionBoost,
      )
    : props.items,
)

// Live price/end overlay for auctions still in play, exactly as ItemsGrid does — a rail showing an
// auction ending in minutes must not display a stale price. Terminal items drop out so the poll stops.
const { live } = useLiveItems(() => props.items.filter(i => i.type === ItemType.auction && !i.closed && !i.sold))

// Memoize image URLs off stable item identity so a live tick doesn't rebuild them (parity with ItemsGrid).
const media = computed(() => {
  const m = new Map<string, { image: string; srcset: string }>()
  for (const item of props.items) {
    m.set(item.id, { image: getCardImage(item.image), srcset: dprSrcset(item.image, '380x280') })
  }
  return m
})

const cards = computed(() =>
  ranked.value.map(item => {
    const l = live.value.get(item.id)
    const view = l ? applyLiveItem(item, l) : item
    return toCardView(view, media.value.get(item.id)!)
  }),
)

// Desktop scroll affordance (mobile uses native touch scroll).
const { track, canLeft, canRight, updateArrows, scrollByPage } = useScrollArrows()
watch(cards, () => nextTick(updateArrows))
</script>

<template>
  <section v-if="cards.length" class="reco-rail">
    <h2 class="reco-rail-title">{{ title }}</h2>
    <div class="rail">
      <button
        v-show="canLeft"
        type="button"
        class="rail-arrow rail-arrow-prev"
        :aria-label="t('galleryPrevious')"
        @click="scrollByPage(-1)"
      >
        <Icon name="heroicons-outline:chevron-left" class="rail-arrow-icon" />
      </button>
      <div ref="track" class="rail-track">
        <div v-for="(card, i) in cards" :key="card.item.id" class="rail-item">
          <ItemCard :card="card" :index="i" :surface="surface" />
        </div>
      </div>
      <button
        v-show="canRight"
        type="button"
        class="rail-arrow rail-arrow-next"
        :aria-label="t('galleryNext')"
        @click="scrollByPage(1)"
      >
        <Icon name="heroicons-outline:chevron-right" class="rail-arrow-icon" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.reco-rail {
  @apply my-12;
}

.reco-rail-title {
  @apply mb-4 text-24 font-bold text-app-text-strong;
}

.rail {
  @apply relative;
}

/* overflow-x-auto computes overflow-y to auto, which would clip the FlagBadge's corner
   overhang — symmetric p-2 reserves room inside the scrollport so the round flag stays visible. */
.rail-track {
  @apply flex gap-3 overflow-x-auto scroll-smooth p-2;
}

/* Flex children stretch by default; the card is h-full, so every card matches the tallest. */
.rail-item {
  @apply w-56 shrink-0 sm:w-64;
}

.rail-arrow {
  @apply absolute top-1/3 z-1 hidden h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-app-surface text-app-text-muted shadow-md md:flex;

  &:hover {
    @apply text-app-primary;
  }
}

.rail-arrow-prev {
  @apply left-1;
}

.rail-arrow-next {
  @apply right-1;
}

.rail-arrow-icon {
  @apply h-5 w-5;
}
</style>
