<script lang="ts" setup>
import { FUEL_TYPES, TRANSMISSIONS, BODY_TYPES, DRIVE_TYPES, VEHICLE_COLORS } from '~/models'
import type { OptionItem } from '~/models'

const { t } = useI18n()
const { facets, setFacet, reset } = useSearchFilters()
const { categories, fetchCategories } = useCategories()

// Categories drive the category facet; fetch lazily (idempotent — no-op if already loaded).
onMounted(fetchCategories)

const categoryOptions = computed<OptionItem[]>(() => categories.value.map(c => ({ label: c.title, value: c.id })))

// Enum facets reuse the existing vehicle: i18n group for option labels (the field labels are the
// new search: keys). Built as computed so labels react to a locale switch.
const fuelOptions = computed<OptionItem[]>(() => FUEL_TYPES.map(v => ({ label: t(`vehicle.fuel.${v}`), value: v })))
const transmissionOptions = computed<OptionItem[]>(() =>
  TRANSMISSIONS.map(v => ({ label: t(`vehicle.trans.${v}`), value: v })),
)
const bodyOptions = computed<OptionItem[]>(() => BODY_TYPES.map(v => ({ label: t(`vehicle.body.${v}`), value: v })))
const driveOptions = computed<OptionItem[]>(() => DRIVE_TYPES.map(v => ({ label: t(`vehicle.drive.${v}`), value: v })))
const colorOptions = computed<OptionItem[]>(() =>
  VEHICLE_COLORS.map(v => ({ label: t(`vehicle.colors.${v}`), value: v })),
)

const typeOptions = computed<OptionItem[]>(() => [
  { label: t('search.facetTypeAuction'), value: 'auction' },
  { label: t('search.facetTypeAd'), value: 'ad' },
])

const hasAnyFilter = computed(() => Object.keys(facets.value).length > 0)
</script>

<template>
  <aside class="filters" :aria-label="t('search.filters')">
    <header class="filters-head">
      <h2 class="filters-title">{{ t('search.filters') }}</h2>
      <button v-if="hasAnyFilter" type="button" class="reset-btn" @click="reset">
        <Icon name="heroicons-outline:x-mark" class="reset-icon" />
        {{ t('search.clearFilters') }}
      </button>
    </header>

    <div class="field">
      <BaseSelect
        :value="facets.type"
        :label="t('search.facetType')"
        :options="typeOptions"
        :searchable="false"
        @update:value="v => setFacet('type', v || undefined)"
      />
    </div>

    <div class="field">
      <BaseSelect
        :value="facets.categoryId"
        :label="t('search.facetCategory')"
        :options="categoryOptions"
        @update:value="v => setFacet('categoryId', v || undefined)"
      />
    </div>

    <div class="field-row">
      <BaseInput
        type="number"
        :value="facets.priceMin"
        :label="t('search.facetPriceMin')"
        @update:value="v => setFacet('priceMin', v)"
      />
      <BaseInput
        type="number"
        :value="facets.priceMax"
        :label="t('search.facetPriceMax')"
        @update:value="v => setFacet('priceMax', v)"
      />
    </div>

    <div class="field">
      <BaseSelect
        :value="facets.fuelType"
        :label="t('search.facetFuel')"
        :options="fuelOptions"
        :searchable="false"
        @update:value="v => setFacet('fuelType', v || undefined)"
      />
    </div>

    <div class="field">
      <BaseSelect
        :value="facets.bodyType"
        :label="t('search.facetBody')"
        :options="bodyOptions"
        :searchable="false"
        @update:value="v => setFacet('bodyType', v || undefined)"
      />
    </div>

    <div class="field">
      <BaseSelect
        :value="facets.transmission"
        :label="t('search.facetTransmission')"
        :options="transmissionOptions"
        :searchable="false"
        @update:value="v => setFacet('transmission', v || undefined)"
      />
    </div>

    <div class="field">
      <BaseSelect
        :value="facets.driveType"
        :label="t('search.facetDrive')"
        :options="driveOptions"
        :searchable="false"
        @update:value="v => setFacet('driveType', v || undefined)"
      />
    </div>

    <div class="field">
      <BaseSelect
        :value="facets.color"
        :label="t('search.facetColor')"
        :options="colorOptions"
        :searchable="false"
        @update:value="v => setFacet('color', v || undefined)"
      />
    </div>

    <div class="field-row">
      <BaseInput
        type="number"
        :value="facets.yearFrom"
        :label="t('search.facetYearFrom')"
        @update:value="v => setFacet('yearFrom', v)"
      />
      <BaseInput
        type="number"
        :value="facets.yearTo"
        :label="t('search.facetYearTo')"
        @update:value="v => setFacet('yearTo', v)"
      />
    </div>
  </aside>
</template>

<style scoped>
.filters {
  @apply flex flex-col gap-4 rounded-lg border border-app-border bg-app-surface p-4;
}

.filters-head {
  @apply flex items-center justify-between;
}

.filters-title {
  @apply text-18 font-semibold text-app-text-strong;
}

.reset-btn {
  @apply inline-flex items-center gap-1 text-sm font-medium text-app-primary;

  &:hover {
    @apply underline;
  }
}

.reset-icon {
  @apply h-4 w-4;
}

.field {
  @apply flex flex-col;
}

.field-row {
  @apply grid grid-cols-2 gap-3;
}
</style>
