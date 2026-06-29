<script lang="ts" setup>
import { SEARCH_SORTS } from '~/models'
import type { OptionItem, SearchQuery, SearchSort } from '~/models'

const props = defineProps<{ q?: string }>()
const { t } = useI18n()

const { facets, sort, query, clearFacet, setSort } = useSearchFilters({ q: () => props.q })

// Sort options, labelled from the search: i18n group. Order follows SEARCH_SORTS (relevance first).
const SORT_LABEL: Record<SearchSort, string> = {
  relevance: 'search.sortRelevance',
  newest: 'search.sortNewest',
  priceAsc: 'search.sortPriceAsc',
  priceDesc: 'search.sortPriceDesc',
}
const sortOptions = computed<OptionItem[]>(() => SEARCH_SORTS.map(s => ({ label: t(SORT_LABEL[s]), value: s })))

const { items, total, page, pageSize, pending } = usePagedItems({
  endpoint: '/api/search',
  query: () => query.value,
  key: 'items:search',
})

// Active facet chips: one per set facet, with the localized label + a remove control. The facet
// VALUE is shown raw for free-text/number facets and via the vehicle: label group for enums.
type Facet = Exclude<keyof SearchQuery, 'q'>

const ENUM_LABEL_GROUP: Partial<Record<Facet, string>> = {
  type: 'search.facetType', // value rendered separately below
  fuelType: 'vehicle.fuel',
  bodyType: 'vehicle.body',
  transmission: 'vehicle.trans',
  driveType: 'vehicle.drive',
  color: 'vehicle.colors',
}

const FACET_LABEL: Record<Facet, string> = {
  type: 'search.facetType',
  categoryId: 'search.facetCategory',
  priceMin: 'search.facetPriceMin',
  priceMax: 'search.facetPriceMax',
  fuelType: 'search.facetFuel',
  bodyType: 'search.facetBody',
  transmission: 'search.facetTransmission',
  driveType: 'search.facetDrive',
  color: 'search.facetColor',
  yearFrom: 'search.facetYearFrom',
  yearTo: 'search.facetYearTo',
}

const valueLabel = (key: Facet, value: unknown): string => {
  if (key === 'type') return t(`search.facetType${value === 'auction' ? 'Auction' : 'Ad'}`)
  const group = ENUM_LABEL_GROUP[key]
  return group ? t(`${group}.${value}`) : String(value)
}

const activeChips = computed(() =>
  (Object.keys(facets.value) as Facet[]).map(key => ({
    key,
    label: t(FACET_LABEL[key]),
    value: valueLabel(key, facets.value[key]),
  })),
)
</script>

<template>
  <div class="results">
    <header class="results-head">
      <BaseSelect
        class="sort"
        :value="sort"
        :label="t('search.sortLabel')"
        :options="sortOptions"
        :searchable="false"
        @update:value="v => setSort(v || 'relevance')"
      />
    </header>

    <ul v-if="activeChips.length" role="list" class="chips">
      <li v-for="chip in activeChips" :key="chip.key" class="chip">
        <span class="chip-label">{{ chip.label }}:</span>
        <span class="chip-value">{{ chip.value }}</span>
        <button type="button" class="chip-remove" :aria-label="t('search.clearFilters')" @click="clearFacet(chip.key)">
          <Icon name="heroicons-outline:x-mark" class="chip-icon" />
        </button>
      </li>
    </ul>

    <ItemsListing
      v-model:page="page"
      :items="items"
      :total="total"
      :page-size="pageSize"
      :pending="pending"
      search-context
    />
  </div>
</template>

<style scoped>
.results {
  @apply flex flex-col gap-4;
}

.results-head {
  @apply flex justify-end;
}

.sort {
  @apply w-full sm:w-56;
}

.chips {
  @apply flex flex-wrap gap-2;
}

.chip {
  @apply inline-flex items-center gap-1 rounded-full border border-app-border bg-app-surface-muted px-3 py-1 text-sm;
}

.chip-label {
  @apply text-app-text-muted;
}

.chip-value {
  @apply font-medium text-app-text-strong;
}

.chip-remove {
  @apply ml-1 inline-flex text-app-text-muted;

  &:hover {
    @apply text-app-primary;
  }
}

.chip-icon {
  @apply h-4 w-4;
}
</style>
