<script setup lang="ts">
import { liveItem, mockGps, mockItems } from './fixtures'

const listPage = ref(1)
const listingPending = ref(false)
const showSkeleton = ref(false)
</script>

<template>
  <PlaygroundSection id="domain" title="Vehicle / domain" subtitle="Item cards, status, specs, listings & maps.">
    <PlaygroundSpecimen
      name="ItemStatus"
      tag="component"
      surface="white"
      :chips="['item', 'compact', 'showDate', 'inline']"
      description="All six lifecycle states + display variants (live countdown ticks)."
    >
      <div class="pg-status-grid">
        <div v-for="it in mockItems" :key="it.id" class="pg-status-cell">
          <span class="pg-status-title">{{ it.title }}</span>
          <ItemStatus :item="it" />
        </div>
      </div>
      <div class="pg-status-variants">
        <div class="pg-status-cell">
          <span class="pg-status-title">default</span>
          <ItemStatus :item="liveItem" />
        </div>
        <div class="pg-status-cell">
          <span class="pg-status-title">compact</span>
          <ItemStatus :item="liveItem" compact />
        </div>
        <div class="pg-status-cell">
          <span class="pg-status-title">inline + showDate</span>
          <ItemStatus :item="liveItem" inline show-date />
        </div>
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="ItemInfo"
      tag="component"
      :chips="['item']"
      description="Current-price panel with status."
    >
      <ItemInfo :item="liveItem" />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="ItemVehicle"
      tag="component"
      :chips="['item.specs']"
      description="VIN-decoded specification table."
    >
      <ItemVehicle :item="liveItem" />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="ItemDescription"
      tag="component"
      :chips="['item']"
      description="Locale-aware description + contact."
    >
      <ItemDescription :item="liveItem" />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="ItemContact" tag="component" surface="white" :chips="['item']">
      <ItemContact :item="liveItem" />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="ItemLocation" tag="component" surface="white" :chips="['item']">
      <ItemLocation :item="liveItem" />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="ItemsGrid"
      tag="component"
      :chips="['items']"
      description="Responsive card grid — compare & favourite overlays, live status."
    >
      <ItemsGrid :items="mockItems" />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="ItemsListing"
      tag="component"
      :chips="['items', 'total', 'pageSize', 'pending', 'page']"
      description="Grid + count + pagination, with loading & skeleton states."
    >
      <ItemsListing
        v-model:page="listPage"
        :items="showSkeleton ? undefined : mockItems"
        :total="mockItems.length"
        :page-size="10"
        :pending="listingPending"
      />
      <template #controls>
        <BaseCheckbox v-model:value="showSkeleton" label="skeleton (items=undefined)" />
        <BaseCheckbox v-model:value="listingPending" label="pending" />
      </template>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="CategoriesGrid" tag="component" description="Category tiles — live reference data.">
      <CategoriesGrid />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="StaticMap" tag="component" :chips="['gps']" description="Keyless OpenStreetMap embed.">
      <div class="pg-map">
        <StaticMap :gps="mockGps" />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Pano"
      tag="component"
      :chips="['source', 'type']"
      description="360° still with hover overlay."
    >
      <div class="pg-pano">
        <Pano source="https://picsum.photos/seed/pano/1280/640" />
      </div>
    </PlaygroundSpecimen>
  </PlaygroundSection>
</template>

<style scoped>
.pg-status-grid {
  @apply grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3;
}

.pg-status-cell {
  @apply flex flex-col items-start gap-2;
}

.pg-status-title {
  @apply font-mono text-xs text-gray-400;
}

.pg-status-variants {
  @apply mt-6 flex flex-wrap gap-8 border-t border-gray-200 pt-6;
}

.pg-map {
  @apply h-64 w-full overflow-hidden rounded-lg ring-1 ring-gray-200;
}

.pg-pano {
  @apply max-w-xl;
}
</style>
