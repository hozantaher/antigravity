<script setup lang="ts">
// `tone` maps to a class below (we can't @apply a dynamic colour, so each token gets a class).
defineProps<{
  name: string
  hex: string
  tone: string
}>()
</script>

<template>
  <div class="pg-swatch">
    <div class="pg-swatch-chip" :class="`is-${tone}`" />
    <div class="pg-swatch-meta">
      <span class="pg-swatch-name">{{ name }}</span>
      <span class="pg-swatch-hex">{{ hex }}</span>
    </div>
  </div>
</template>

<style scoped>
.pg-swatch {
  @apply flex flex-col gap-1.5;
}

.pg-swatch-chip {
  @apply h-14 w-full rounded-lg ring-1 ring-black/10;

  &.is-primary {
    @apply bg-app-primary;
  }

  &.is-red {
    @apply bg-app-red;
  }

  &.is-green {
    @apply bg-app-green;
  }

  &.is-amber {
    @apply bg-app-amber;
  }

  &.is-bg {
    @apply bg-app-bg;
  }

  &.is-surface {
    @apply bg-app-surface;
  }

  &.is-surface-muted {
    @apply bg-app-surface-muted;
  }

  &.is-border {
    @apply bg-app-border;
  }

  &.is-border-strong {
    @apply bg-app-border-strong;
  }

  &.is-text {
    @apply bg-app-text;
  }

  &.is-text-muted {
    @apply bg-app-text-muted;
  }

  &.is-text-strong {
    @apply bg-app-text-strong;
  }

  &.is-black {
    @apply bg-app-black;
  }

  &.is-white {
    @apply bg-app-white;
  }

  &.is-g100 {
    @apply bg-gray-100;
  }

  &.is-g300 {
    @apply bg-gray-300;
  }

  &.is-g500 {
    @apply bg-gray-500;
  }

  &.is-g700 {
    @apply bg-gray-700;
  }

  &.is-g900 {
    @apply bg-gray-900;
  }
}

.pg-swatch-meta {
  @apply flex flex-col;
}

.pg-swatch-name {
  @apply font-mono text-xs font-medium text-gray-900;
}

.pg-swatch-hex {
  @apply font-mono text-xs text-gray-400;
}
</style>
