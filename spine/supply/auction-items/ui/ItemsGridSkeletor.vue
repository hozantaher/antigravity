<script lang="ts" setup>
import { Skeletor } from 'vue-skeletor'

defineProps<{
  count?: number
}>()
</script>

<template>
  <div class="cards-grid">
    <div v-for="i in count ?? 4" :key="i" class="card">
      <div class="media">
        <Skeletor class="media-img" width="100%" height="100%" />
      </div>
      <div class="body">
        <div class="title-row">
          <div class="title-text">
            <Skeletor class="title-line" />
            <Skeletor width="60%" class="title-line" />
          </div>
          <Icon name="heroicons-outline:star" class="star-icon" />
        </div>

        <div class="location-row">
          <Icon name="heroicons-outline:location-marker" class="location-icon" />
          <Skeletor width="40%" />
        </div>

        <div class="price-row">
          <Skeletor width="40%" class="price" />

          <div class="timer-col">
            <Skeletor class="bid-line" />
            <div class="timer-row">
              <Icon name="heroicons-outline:clock" class="timer-icon" />
              <Skeletor />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cards-grid {
  @apply grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 lg:gap-3 2xl:grid-cols-5 2xl:gap-5;
}

.card {
  @apply col-span-1 flex flex-col overflow-hidden rounded-lg border border-app-border bg-app-surface;
}

.media {
  @apply flex-shrink-0;
}

.media-img {
  @apply aspect-4-3 w-full;
}

.body {
  @apply flex flex-1 flex-col justify-between p-6;
}

.title-row {
  @apply flex justify-between;
}

.title-text {
  @apply w-full;
}

.title-line {
  @apply text-sm md:text-base 2xl:text-lg;
}

.star-icon {
  @apply ml-3 shrink-0 text-sm text-app-border-strong md:text-16;
}

.location-row {
  @apply mt-2 flex items-center text-app-border-strong md:mt-3;
}

.location-icon {
  @apply mr-1.5;
}

.price-row {
  @apply mt-3 flex items-center justify-between md:mt-4.5;
}

.price {
  @apply xl:text-lg;
}

.timer-col {
  @apply w-1/2;
}

.bid-line {
  @apply text-xs font-medium sm:text-sm;
}

.timer-row {
  @apply flex items-center text-xs sm:text-sm;
}

.timer-icon {
  @apply mr-1 text-app-border-strong;
}
</style>
