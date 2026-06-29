<script lang="ts" setup>
interface Crumb {
  label: string
  to?: string
}

// The last crumb is the current page: rendered as text (aria-current), never a link.
defineProps<{ items: Crumb[] }>()

const { t } = useI18n()
</script>

<template>
  <nav class="breadcrumb" :aria-label="t('seo.breadcrumb')">
    <ol class="crumbs">
      <li v-for="(crumb, i) in items" :key="i" class="crumb">
        <span v-if="i > 0" aria-hidden="true" class="crumb-sep">/</span>
        <NuxtLinkLocale v-if="crumb.to && i < items.length - 1" :to="crumb.to" class="crumb-link">
          {{ crumb.label }}
        </NuxtLinkLocale>
        <span v-else-if="i === items.length - 1" class="crumb-current" aria-current="page">{{ crumb.label }}</span>
        <span v-else class="crumb-current">{{ crumb.label }}</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.breadcrumb {
  @apply mb-4;
}

.crumbs {
  @apply flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-app-text-muted;
}

.crumb {
  @apply inline-flex items-center gap-x-2;
}

.crumb-sep {
  @apply text-app-text-muted opacity-60;
}

.crumb-link {
  @apply text-app-text-muted transition-colors hover:text-app-primary;
}

.crumb-current {
  @apply font-medium text-app-text-strong;
}
</style>
