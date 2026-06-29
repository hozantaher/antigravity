<script setup lang="ts">
defineProps<{
  id: string
  title: string
  subtitle?: string
}>()

// Specimens register on mount and report search-visibility; when every child is filtered
// out the whole section (incl. its heading) collapses.
const visibles = reactive(new Map<number, boolean>())
let seq = 0

provide(PG_SECTION_KEY, () => {
  const key = seq++
  visibles.set(key, true)
  onScopeDispose(() => visibles.delete(key))
  return (visible: boolean) => visibles.set(key, visible)
})

const hasVisible = computed(() => visibles.size === 0 || [...visibles.values()].some(Boolean))
</script>

<template>
  <section v-show="hasVisible" :id="id" class="pg-section">
    <div class="pg-section-head">
      <h2 class="pg-section-title">{{ title }}</h2>
      <p v-if="subtitle" class="pg-section-sub">{{ subtitle }}</p>
    </div>
    <div class="pg-section-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.pg-section {
  @apply scroll-mt-8;
}

.pg-section-head {
  @apply border-b border-gray-200 pb-3;
}

.pg-section-title {
  @apply text-2xl font-bold text-gray-900;
}

.pg-section-sub {
  @apply mt-1 text-sm text-gray-500;
}

.pg-section-body {
  @apply mt-6 flex flex-col gap-6;
}
</style>
