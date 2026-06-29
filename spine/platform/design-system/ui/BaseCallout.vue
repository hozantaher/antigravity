<script setup lang="ts">
// Tinted, left-accented banner for action-required moments (settlement due, deposit needed,
// outbid). Flat/border-first like the rest of the system; variant drives the semantic colour.
type CalloutVariant = 'info' | 'success' | 'warning' | 'danger'

interface Props {
  variant?: CalloutVariant
  title?: string
  icon?: string
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'info',
})

const DEFAULT_ICONS: Record<CalloutVariant, string> = {
  info: 'heroicons-outline:information-circle',
  success: 'heroicons-outline:check-circle',
  warning: 'heroicons-outline:exclamation',
  danger: 'heroicons-outline:exclamation-circle',
}

const iconName = computed((): string => props.icon ?? DEFAULT_ICONS[props.variant])
</script>

<template>
  <div class="callout" :class="`is-${variant}`" role="status">
    <Icon :name="iconName" class="callout-icon" aria-hidden="true" />
    <div class="callout-main">
      <p v-if="title" class="callout-title">{{ title }}</p>
      <div v-if="$slots.default" class="callout-body">
        <slot />
      </div>
    </div>
    <div v-if="$slots.actions" class="callout-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.callout {
  @apply flex items-start gap-3 rounded-lg border border-l-4 border-app-border bg-app-surface px-4 py-3;

  &.is-info {
    @apply border-l-app-primary;
  }

  &.is-success {
    @apply border-l-app-green;
  }

  &.is-warning {
    @apply border-l-app-amber;
  }

  &.is-danger {
    @apply border-l-app-red;
  }
}

.callout-icon {
  @apply mt-0.5 h-5 w-5 shrink-0;

  .is-info & {
    @apply text-app-primary;
  }

  .is-success & {
    @apply text-app-green;
  }

  .is-warning & {
    @apply text-app-amber;
  }

  .is-danger & {
    @apply text-app-red;
  }
}

.callout-main {
  @apply min-w-0 flex-1;
}

.callout-title {
  @apply text-sm font-semibold text-app-text-strong;
}

.callout-body {
  @apply mt-1 text-sm text-app-text-muted;
}

.callout-actions {
  @apply flex shrink-0 items-center gap-2;
}
</style>
