<script lang="ts" setup>
import { ItemType, type Item } from '~/models'

const route = useRoute()
const router = useRouter()
const localePath = useLocalePath()
const { t } = useI18n()
const { remove: removeFromStore, maxItems } = useCompare()
const { getCardImage } = useImageProcessing()

useSeo({ title: () => t('compare.pageTitle'), noindex: true })

const parsedIds = computed<string[]>(() => {
  const raw = route.query.ids
  if (typeof raw !== 'string' || !raw) return []
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, maxItems)
})

// Fetch each id independently so one deleted/invalid item doesn't blank the whole comparison.
const { data, pending } = await useAsyncData(
  () => `compare:${parsedIds.value.join(',')}`,
  async () => {
    const results = await Promise.all(parsedIds.value.map(async id => ({ id, item: await fetchItemOrNull(id) })))
    return {
      items: results.filter((r): r is { id: string; item: Item } => r.item !== null).map(r => r.item),
      failedCount: results.filter(r => r.item === null).length,
    }
  },
  { watch: [parsedIds] },
)

const items = computed<Item[]>(() => data.value?.items ?? [])
const failedCount = computed(() => data.value?.failedCount ?? 0)

// Columns are clamp-capped, NOT 1fr: with 1–2 items, 1fr stretched each column (and its header
// image) to the full container width. clamp keeps them card-sized on desktop and shrinks them on
// small screens. Inline because stylelint bans raw grid-template-columns and linters don't scan :style.
const gridStyle = computed(() => ({
  gridTemplateColumns: `clamp(6rem, 24vw, 10rem) repeat(${items.value.length}, clamp(8.5rem, 40vw, 14rem))`,
}))

interface CompareRow {
  label: string
  values: string[]
}

const DASH = '—'

// Collapse the two repeated row shapes: a "<number> <unit>" measurement and an i18n-keyed enum.
const unit = (v: number | null | undefined, u: string): string | undefined => (v != null ? `${v} ${u}` : undefined)
const enumLabel = (v: string | null | undefined, group: string): string | undefined =>
  v ? t(`vehicle.${group}.${v}`) : undefined

const rows = computed<CompareRow[]>(() => {
  const list = items.value
  if (!list.length) return []

  const out: CompareRow[] = []
  // Keep a row when at least one vehicle has a value; render '—' for the rest so columns align.
  const add = (label: string, get: (i: Item) => string | number | undefined | null): void => {
    const values = list.map(i => {
      const v = get(i)
      return v === undefined || v === null || v === '' ? DASH : String(v)
    })
    if (values.some(v => v !== DASH)) out.push({ label, values })
  }

  // Price always renders (formatPrice yields a value or '---'), so it's a fixed lead row.
  out.push({ label: t('compare.price'), values: list.map(i => formatPrice(itemCurrentPrice(i) ?? i.priceFrom)) })
  add(t('type'), i => (i.type === ItemType.auction ? t('typeAuction') : t('typeAd')))
  add(t('location'), i => i.location)

  add(t('vehicle.brand'), i => i.specs?.manufacturer)
  add(t('vehicle.model'), i => i.specs?.model)
  add(t('vehicle.year'), i => i.specs?.yearOfManufacture)
  add(t('vehicle.firstRegistration'), i => (i.firstRegistrationDate ? formatDate(i.firstRegistrationDate) : undefined))
  add(t('vehicle.fuelType'), i => enumLabel(i.fuelType, 'fuel'))
  add(t('vehicle.transmission'), i => enumLabel(i.transmission, 'trans'))
  add(t('vehicle.bodyType'), i => enumLabel(i.bodyType, 'body'))
  add(t('vehicle.driveType'), i => enumLabel(i.driveType, 'drive'))
  add(t('vehicle.color'), i => enumLabel(i.color, 'colors'))
  add(t('vehicle.power'), i => {
    if (i.enginePowerKw != null) {
      const hp = i.specs?.enginePowerHp != null ? ` (${i.specs.enginePowerHp} HP)` : ''
      return `${i.enginePowerKw} kW${hp}`
    }
    return i.specs?.enginePowerHp != null ? `${i.specs.enginePowerHp} HP` : undefined
  })
  add(t('vehicle.displacement'), i => unit(i.engineDisplacementCcm, 'ccm'))
  add(t('vehicle.gears'), i => i.specs?.numberOfGears)
  add(t('vehicle.emission'), i => i.specs?.emissionStandard)
  add(t('vehicle.co2'), i => unit(i.specs?.co2EmissionGkm, 'g/km'))
  add(t('vehicle.doors'), i => i.specs?.numberOfDoors)
  add(t('vehicle.seats'), i => i.specs?.numberOfSeats)
  add(t('vehicle.axles'), i => i.specs?.numberOfAxles)
  add(t('vehicle.length'), i => unit(i.specs?.lengthMm, 'mm'))
  add(t('vehicle.width'), i => unit(i.specs?.widthMm, 'mm'))
  add(t('vehicle.height'), i => unit(i.specs?.heightMm, 'mm'))
  add(t('vehicle.wheelbase'), i => unit(i.specs?.wheelbaseMm, 'mm'))
  add(t('vehicle.weight'), i => unit(i.specs?.weightEmptyKg, 'kg'))
  add(t('vehicle.maxSpeed'), i => unit(i.specs?.maxSpeedKmh, 'km/h'))
  add(t('vehicle.vin'), i => i.vin)

  return out
})

const removeItem = (id: string): void => {
  removeFromStore(id)
  const rest = parsedIds.value.filter(x => x !== id)
  router.replace(localePath(rest.length ? `/compare?ids=${rest.join(',')}` : '/compare'))
}
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <h1 class="app-h1">{{ t('compare.title') }}</h1>
      <p class="hint">{{ t('compare.hint', { max: maxItems }) }}</p>

      <Loading v-if="pending" />

      <template v-else>
        <p v-if="failedCount" class="failed" role="alert">{{ t('compare.failedToLoad', { count: failedCount }) }}</p>

        <div v-if="!items.length" class="empty">
          <p class="empty-title">{{ t('compare.empty') }}</p>
          <p class="empty-hint">{{ t('compare.emptyHint') }}</p>
          <NuxtLinkLocale to="/auctions" class="app-btn empty-cta">{{ t('allAuctions') }}</NuxtLinkLocale>
        </div>

        <div v-else class="compare-scroll">
          <div class="compare-table">
            <div class="compare-row is-head" :style="gridStyle">
              <div class="corner-cell" />
              <div v-for="item in items" :key="item.id" class="head-cell">
                <button
                  type="button"
                  class="head-remove"
                  :aria-label="t('compare.removeAria', { title: item.title })"
                  @click="removeItem(item.id)"
                >
                  <Icon name="heroicons-outline:x" class="head-remove-icon" />
                </button>
                <NuxtLinkLocale :to="itemPath(item)" class="head-media">
                  <img :src="getCardImage(item.image)" :alt="item.title" class="head-image" />
                </NuxtLinkLocale>
                <NuxtLinkLocale :to="itemPath(item)" class="head-title">{{ item.title }}</NuxtLinkLocale>
              </div>
            </div>

            <div v-for="row in rows" :key="row.label" class="compare-row" :style="gridStyle">
              <div class="label-col">{{ row.label }}</div>
              <div v-for="(value, i) in row.values" :key="i" class="item-col">{{ value }}</div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.hint {
  @apply mt-2 text-app-text-muted;
}

.failed {
  @apply mt-4 rounded-lg border border-app-red bg-app-red/10 px-4 py-3 text-sm text-app-red;
}

.empty {
  @apply mt-10 flex flex-col items-center gap-3 text-center;
}

.empty-title {
  @apply text-lg font-semibold;
}

.empty-hint {
  @apply text-app-text-muted;
}

.empty-cta {
  @apply mt-2 max-w-xs;
}

.compare-scroll {
  @apply mt-6 overflow-x-auto;
}

/* w-max so the box hugs its content — a 1–2 item comparison stays a tidy card instead of a
   full-width box with giant columns; wider sets overflow into the scroll container. */
.compare-table {
  @apply w-max overflow-hidden rounded-xl border border-app-border bg-app-surface;
}

.compare-row {
  @apply grid border-b border-app-border;

  &.is-head {
    @apply border-b-0;
  }
}

.corner-cell {
  @apply bg-app-surface-muted;
}

.head-cell {
  @apply relative flex flex-col items-center gap-2 p-3;
}

.head-remove {
  @apply absolute top-2 right-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-app-surface-muted text-app-text-muted hover:bg-app-border;
}

.head-remove-icon {
  @apply h-3.5 w-3.5;
}

.head-media {
  @apply block aspect-4-3 w-full overflow-hidden rounded-lg bg-app-surface-muted;
}

.head-image {
  @apply h-full w-full object-cover;
}

.head-title {
  @apply text-center text-sm font-semibold text-app-text-strong hover:text-app-primary;
}

.label-col {
  @apply bg-app-surface-muted px-4 py-3 text-sm font-medium text-app-text-muted;
}

.item-col {
  @apply px-4 py-3 text-sm text-app-text-strong;
}
</style>
