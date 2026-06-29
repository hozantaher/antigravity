<script lang="ts" setup>
import { itemSignalMeta, RECO_CONFIG, type Item, type RecoSurface } from '~/models'
import type { CardView } from '~/features/supply/auction-items/logic/cardView'

// One grid/rail card. Extracted from ItemsGrid so per-card interaction tracking (hover /
// viewport dwell / impression, §3.2) lives in one place and the detail recommendations rail
// can reuse the exact same card. All tracking is no-op until consent (useTracking gates it).
const props = withDefaults(defineProps<{ card: CardView; index: number; surface?: RecoSurface }>(), {
  surface: 'listing',
})

const { user } = useUser()
const favoriteStore = useFavorites()
const { t } = useI18n()
const { has: isComparing, toggleWithToast: toggleCompare } = useCompare()

const hasLastBid = (item: Item) => !!item.bids?.length && item.bids.at(-1)?.userId === user.value?.id

// ── Interaction tracking (§3.2) ────────────────────────────────────────────────
const tracking = useTracking()
const root = ref()
const { supportsHover, isTouch } = usePointerKind()
const meta = () => itemSignalMeta(props.card.item)

// Desktop: longer hover without a click is projected interest. Emit the total dwell on leave;
// the server drops anything under the 800ms threshold and saturates the rest.
const hovered = useElementHover(root)
let enterAt = 0
watch(hovered, h => {
  if (!supportsHover.value) return
  if (h) {
    enterAt = Date.now()
  } else if (enterAt) {
    const ms = Date.now() - enterAt
    enterAt = 0
    if (ms >= RECO_CONFIG.hoverThresholdMs)
      tracking.cardHover(props.card.item.id, ms, props.surface, props.index, meta())
  }
})

// Mobile equivalent: time the card spends in the viewport. Plus a one-shot impression with the
// slot position (logged from day one for later IPS debiasing).
let visibleSince = 0
let impressed = false
useIntersectionObserver(
  root,
  ([entry]) => {
    if (entry?.isIntersecting) {
      if (!impressed) {
        impressed = true
        tracking.impression(props.card.item.id, props.surface, props.index, meta())
      }
      if (isTouch.value && !visibleSince) visibleSince = Date.now()
    } else if (visibleSince) {
      const seconds = (Date.now() - visibleSince) / 1000
      visibleSince = 0
      if (isTouch.value && seconds >= RECO_CONFIG.viewportDwellThresholdSec) {
        tracking.cardViewport(props.card.item.id, seconds, props.surface, props.index, meta())
      }
    }
  },
  { threshold: 0.5 },
)
</script>

<template>
  <NuxtLinkLocale ref="root" :to="itemPath(card.item)" class="card group">
    <div class="card-inner">
      <div class="media">
        <button
          type="button"
          class="compare-overlay"
          :class="{ 'is-active': isComparing(card.item.id) }"
          :aria-label="isComparing(card.item.id) ? t('compare.remove') : t('compare.add')"
          :aria-pressed="isComparing(card.item.id)"
          data-cy="item-card-compare"
          :data-cy-id="card.item.id"
          @click.prevent.stop="toggleCompare(card.item.id)"
        >
          <Icon name="mdi:compare-horizontal" class="compare-overlay-icon" />
        </button>
        <div class="media-frame">
          <img
            :src="card.image"
            :srcset="card.srcset"
            :loading="index < 4 ? 'eager' : 'lazy'"
            :fetchpriority="index === 0 ? 'high' : undefined"
            :alt="card.item.title"
            width="400"
            height="300"
            class="media-image"
          />
        </div>
      </div>
      <div class="body" :class="{ 'is-winning': hasLastBid(card.item) }">
        <div class="header">
          <p class="title">
            {{ card.item.title }}
          </p>
          <Icon
            :name="user?.favoriteIds?.includes(card.item.id) ? 'heroicons-solid:star' : 'heroicons-outline:star'"
            class="favorite"
            @click.prevent="favoriteStore.toggleFavorite(card.item.id)"
          />
        </div>

        <div class="footer">
          <div class="price-col">
            <div v-if="card.price?.amount" class="price">
              {{ formatPrice(card.price) }}
              <span v-if="hasLastBid(card.item)" class="you-badge">{{ t('you') }}</span>
            </div>
            <div v-else class="on-request">
              {{ t('onRequest') }}
            </div>
            <div v-if="card.live" class="bids">
              <Icon name="heroicons-solid:users" class="bids-icon" />
              <span class="bids-count">{{ card.bidCount }} {{ t('bids') }}</span>
            </div>
          </div>
          <ItemStatus :item="card.item" />
        </div>
      </div>
    </div>
    <FlagBadge :country-code="card.item.countryCode" />
  </NuxtLinkLocale>
</template>

<style scoped>
.card {
  /* isolate: vlastní stacking context udrží z-10 FlagBadge uvnitř karty, ať přečuhující
     ikona nepřekryje logo ve fixed headeru (stejný důvod jako u .media). */
  /* h-full: vyplní výšku buňky/rail-itemu, takže karty v řádku/railu mají stejnou výšku. */
  @apply relative isolate col-span-1 block h-full rounded-lg border border-app-border bg-app-surface;
}

.card-inner {
  /* Klip + zaoblení nese vnitřní wrapper, ať FlagBadge přečuhující přes roh .card nezmizí. */
  @apply flex h-full flex-col overflow-hidden rounded-lg;
}

.media {
  /* isolate: contain the compare-overlay's z-index inside the card so it can't
     escape to the root stacking context and paint over the fixed header (also z-10). */
  @apply relative isolate flex-shrink-0;
}

.media-frame {
  @apply aspect-4-3 w-full truncate bg-app-surface-muted;
}

.media-image {
  @apply h-full w-full object-cover transition duration-500 group-hover:scale-105;
}

.compare-overlay {
  @apply absolute top-2 right-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-0 bg-app-black/40 text-white backdrop-blur transition hover:bg-app-black/60;

  &.is-active {
    @apply bg-app-primary;
  }
}

.compare-overlay-icon {
  @apply text-18;
}

.body {
  @apply flex flex-1 flex-col justify-between p-3 xl:p-6;

  &.is-winning {
    @apply bg-app-green/10;
  }
}

.header {
  @apply flex justify-between;
}

.title {
  @apply text-sm font-semibold text-app-text-strong md:text-base 2xl:text-lg;
}

.favorite {
  @apply ml-3 shrink-0 cursor-pointer text-18 text-app-amber md:text-24;
}

.footer {
  @apply mt-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 md:mt-4.5;
}

.price-col {
  @apply truncate xl:text-lg;
}

.price {
  @apply flex items-center gap-1.5 whitespace-nowrap;
}

.you-badge {
  @apply hidden items-center rounded-full bg-app-green px-2.5 py-0.5 text-base leading-5 font-medium text-white md:block;
}

.on-request {
  @apply whitespace-nowrap;
}

.bids {
  @apply flex items-center gap-1 text-app-red;
}

.bids-icon {
  @apply text-16;
}

.bids-count {
  @apply text-sm;
}
</style>
