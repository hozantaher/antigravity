<script lang="ts" setup>
import hiw1Img from '~/assets/images/hiw1.svg'
import hiw2Img from '~/assets/images/hiw2.svg'
import hiw3Img from '~/assets/images/hiw3.svg'

const { t } = useI18n()

const incentives = computed(() => [
  { name: `1. ${t('hiwTitle1')}`, imageSrc: hiw1Img, description: t('hiwDesc1') },
  { name: `2. ${t('hiwTitle2')}`, imageSrc: hiw2Img, description: t('hiwDesc2') },
  { name: `3. ${t('hiwTitle3')}`, imageSrc: hiw3Img, description: t('hiwDesc3') },
])
</script>

<template>
  <div>
    <div class="heading">
      <h2 class="app-h1">
        {{ t('hiw') }}
      </h2>
    </div>
    <div class="incentives-grid">
      <div v-for="incentive in incentives" :key="incentive.name" class="incentive">
        <div class="media">
          <div class="media-inner">
            <img class="image" :src="incentive.imageSrc" :alt="incentive.name" loading="lazy" />
          </div>
        </div>
        <div class="copy">
          <h3 class="incentive-title">
            {{ incentive.name }}
          </h3>
          <p class="incentive-desc">
            {{ incentive.description }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.heading {
  @apply text-center;
}

.incentives-grid {
  @apply mx-auto mt-12 grid max-w-sm grid-cols-1 gap-x-8 gap-y-10 sm:max-w-none lg:grid-cols-3;
}

.incentive {
  @apply text-center sm:flex sm:text-left lg:block lg:text-center;
}

.media {
  @apply sm:flex-shrink-0;
}

.media-inner {
  @apply flow-root;
}

.image {
  @apply mx-auto h-16 w-16;
}

.copy {
  @apply mt-3 sm:mt-0 sm:ml-6 lg:mt-6 lg:ml-0;
}

.incentive-title {
  @apply text-sm font-medium text-app-text-strong uppercase;
}

.incentive-desc {
  @apply mt-2 text-sm text-app-text-muted;
}
</style>
