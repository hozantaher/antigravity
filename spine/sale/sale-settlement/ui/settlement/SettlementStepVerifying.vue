<script setup lang="ts">
defineProps<{
  slow?: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <div class="step">
    <div class="spinner-wrap" aria-hidden="true">
      <Icon name="mdi:loading" class="spinner" />
      <Icon name="heroicons-solid:credit-card" class="spinner-icon" />
    </div>
    <h4 class="step-heading">{{ t('settlement.verifyingTitle') }}</h4>
    <p v-if="slow" class="slow-note">{{ t('settlement.verifyingSlow') }}</p>
  </div>
</template>

<style scoped>
.step {
  @apply px-1 py-10 text-center;
}

.spinner-wrap {
  @apply relative mx-auto mb-4 h-16 w-16;
}

.spinner {
  @apply absolute inset-0 h-16 w-16 animate-spin text-app-primary/30;
}

.spinner-icon {
  @apply absolute inset-0 m-auto h-6 w-6 text-app-primary;
}

.step-heading {
  @apply text-lg font-bold text-app-text-strong;
}

.slow-note {
  @apply mx-auto mt-3 max-w-sm text-xs text-app-text-muted;
}
</style>
