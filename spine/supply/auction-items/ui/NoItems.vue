<script lang="ts" setup>
const { t } = useI18n()
</script>

<template>
  <div class="empty">
    <Icon name="heroicons-outline:search-circle" class="empty-icon" />
    <h3 class="empty-title">
      {{ t('noItems') }}
    </h3>
    <p class="empty-desc">
      {{ t('noItemsDesc') }}
    </p>
  </div>
</template>

<style scoped>
.empty {
  @apply text-center;
}

.empty-icon {
  @apply mx-auto h-12 w-12 text-app-text-muted;
}

.empty-title {
  @apply mt-2 font-medium text-app-text-strong;
}

.empty-desc {
  @apply mt-1 text-app-text-muted;
}
</style>
