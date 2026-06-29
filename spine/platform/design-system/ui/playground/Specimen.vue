<script setup lang="ts">
import type { PgSurface } from '~/features/platform/design-system/logic/usePlayground'

const props = withDefaults(
  defineProps<{
    name: string
    tag?: string
    chips?: string[]
    description?: string
    surface?: PgSurface
    padded?: boolean
    center?: boolean
  }>(),
  { padded: true, center: false },
)

const { query, showMeta, surface: globalSurface } = usePlayground()

const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return true
  return props.name.toLowerCase().includes(q) || !!props.tag?.toLowerCase().includes(q)
})

// Report visibility to the enclosing PlaygroundSection (no-op when used standalone).
const report = inject(PG_SECTION_KEY, null)
if (report) {
  const setVisible = report()
  watch(visible, v => setVisible(v), { immediate: true })
}

const stageSurface = computed(() => props.surface ?? globalSurface.value)
</script>

<template>
  <article v-show="visible" class="pg-specimen">
    <div class="pg-specimen-head">
      <div class="pg-specimen-id">
        <span class="pg-specimen-name">{{ name }}</span>
        <span v-if="tag" class="pg-specimen-tag">{{ tag }}</span>
      </div>
      <div v-if="showMeta && chips?.length" class="pg-specimen-chips">
        <code v-for="c in chips" :key="c" class="pg-specimen-chip">{{ c }}</code>
      </div>
    </div>
    <p v-if="description" class="pg-specimen-desc">{{ description }}</p>

    <div class="pg-specimen-stage" :class="[`is-${stageSurface}`, { 'is-padded': padded, 'is-center': center }]">
      <slot />
    </div>

    <div v-if="!!$slots.controls" class="pg-specimen-controls">
      <slot name="controls" />
    </div>
  </article>
</template>

<style scoped>
.pg-specimen {
  @apply rounded-xl border border-gray-200 bg-white p-4 shadow-sm;
}

.pg-specimen-head {
  @apply flex flex-wrap items-center justify-between gap-2;
}

.pg-specimen-id {
  @apply flex items-center gap-2;
}

.pg-specimen-name {
  @apply font-mono text-sm font-semibold text-gray-900;
}

.pg-specimen-tag {
  @apply rounded-full bg-app-red/10 px-2 py-0.5 text-xs font-medium tracking-wide text-app-red uppercase;
}

.pg-specimen-chips {
  @apply flex flex-wrap gap-1;
}

.pg-specimen-chip {
  @apply rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-500;
}

.pg-specimen-desc {
  @apply mt-1 text-sm text-gray-500;
}

.pg-specimen-stage {
  @apply mt-3 rounded-lg border border-gray-200;

  &.is-padded {
    @apply p-6;
  }

  &.is-center {
    @apply flex min-h-24 items-center justify-center;
  }

  &.is-white {
    @apply bg-white;
  }

  &.is-gray {
    @apply bg-gray-50;
  }

  &.is-dark {
    @apply border-gray-700 bg-gray-900;
  }
}

.pg-specimen-controls {
  @apply mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-gray-50 p-3;
}
</style>
