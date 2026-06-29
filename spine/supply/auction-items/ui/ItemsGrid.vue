<script lang="ts" setup>
import { ItemType, type Item } from '~/models'

const props = defineProps<{ items: Item[] }>()
const { getCardImage, dprSrcset } = useImageProcessing()

// Live updates: poll only auctions that can still change (live / not-yet-started / awaiting
// close). Sold or closed ones are terminal and drop out, so the poller can stop.
const { live } = useLiveItems(() => props.items.filter(i => i.type === ItemType.auction && !i.closed && !i.sold))

// Building image URLs is the expensive part (JSON.stringify + encodeURIComponent), so derive them
// off the stable item identity, keyed by id — a live tick (price/end/status) must not rebuild them.
const media = computed(() => {
  const m = new Map<string, { image: string; srcset: string }>()
  for (const item of props.items) {
    m.set(item.id, { image: getCardImage(item.image), srcset: dprSrcset(item.image, '380x280') })
  }
  return m
})

// Overlay the latest live state (new last bid → price, bid count, soft-close-extended end,
// close/winner) onto each card. Cheap spread + helpers; re-runs on a live tick but reuses the
// cached media.
const cards = computed(() =>
  props.items.map(item => {
    const l = live.value.get(item.id)
    const view = l ? applyLiveItem(item, l) : item
    return toCardView(view, media.value.get(item.id)!)
  }),
)
</script>

<template>
  <div class="cards-grid">
    <ItemCard v-for="(card, index) in cards" :key="card.item.id" :card="card" :index="index" surface="listing" />
  </div>
</template>

<style scoped>
.cards-grid {
  @apply grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 lg:gap-3 2xl:grid-cols-5 2xl:gap-5;
}
</style>
