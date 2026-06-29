<script setup lang="ts">
const { t } = useI18n()

useSeo({ title: () => t('aboutTitle'), description: () => t('seo.aboutDescription') })
</script>

<template>
  <section class="app-section">
    <div class="app-container">
      <div class="prose-wrap">
        <div class="heading">
          <Icon name="carbon:dicom-overlay" class="heading-icon" />
          <h3>{{ t('aboutTitle') }}</h3>
        </div>
        <p>{{ t('aboutText') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.prose-wrap {
  @apply mx-auto max-w-2xl;
}

.heading {
  @apply text-center;
}

.heading-icon {
  @apply m-auto -mb-6 text-32;
}
</style>
