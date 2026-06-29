<script lang="ts" setup>
const props = withDefaults(
  defineProps<{
    total: number
    pageSize: number
    variant?: 'default' | 'admin'
  }>(),
  { variant: 'default' },
)

const page = defineModel<number>('page', { required: true })

const { t } = useI18n()

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const from = computed(() => (props.total === 0 ? 0 : (page.value - 1) * props.pageSize + 1))
const to = computed(() => Math.min(page.value * props.pageSize, props.total))

const range = (start: number, end: number): number[] =>
  Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)

// Windowed page list: first, last, current ±1, edge padding, with gap markers.
const pages = computed<(number | 'gap')[]>(() => {
  const last = pageCount.value
  const cur = page.value
  if (last <= 7) return range(1, last)
  const wanted = new Set([1, last, cur - 1, cur, cur + 1])
  if (cur <= 3) [2, 3, 4].forEach(p => wanted.add(p))
  if (cur >= last - 2) [last - 1, last - 2, last - 3].forEach(p => wanted.add(p))
  const sorted = [...wanted].filter(p => p >= 1 && p <= last).sort((a, b) => a - b)
  const out: (number | 'gap')[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1]! > 1) out.push('gap')
    out.push(p)
  })
  return out
})

const go = (p: number) => {
  const next = Math.min(Math.max(1, p), pageCount.value)
  if (next !== page.value) page.value = next
}
</script>

<template>
  <nav
    v-if="pageCount > 1"
    class="pager"
    :class="{ 'is-admin': variant === 'admin' }"
    :aria-label="t('pagination.label')"
  >
    <div class="pager-mobile">
      <button type="button" class="edge-btn" :disabled="page <= 1" @click="go(page - 1)">
        {{ t('pagination.previous') }}
      </button>
      <span class="mobile-status">{{ page }} / {{ pageCount }}</span>
      <button type="button" class="edge-btn" :disabled="page >= pageCount" @click="go(page + 1)">
        {{ t('pagination.next') }}
      </button>
    </div>

    <div class="pager-desktop">
      <p class="summary">
        {{ t('pagination.showing', { from, to, total }) }}
      </p>
      <div class="controls">
        <button
          type="button"
          class="arrow arrow-prev"
          :disabled="page <= 1"
          :aria-label="t('pagination.previous')"
          @click="go(page - 1)"
        >
          <Icon name="heroicons-outline:chevron-left" class="arrow-icon" />
        </button>
        <template v-for="(p, idx) in pages" :key="typeof p === 'number' ? `p${p}` : `gap${idx}`">
          <span v-if="p === 'gap'" class="ellipsis">…</span>
          <button v-else type="button" class="page-num" :class="{ 'is-current': p === page }" @click="go(p)">
            {{ p }}
          </button>
        </template>
        <button
          type="button"
          class="arrow arrow-next"
          :disabled="page >= pageCount"
          :aria-label="t('pagination.next')"
          @click="go(page + 1)"
        >
          <Icon name="heroicons-outline:chevron-right" class="arrow-icon" />
        </button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.pager {
  @apply mt-6 flex items-center justify-between border-t border-app-border pt-4;
}

.pager-mobile {
  @apply flex flex-1 items-center justify-between sm:hidden;
}

.mobile-status {
  @apply text-sm text-app-text-muted;
}

.edge-btn {
  @apply inline-flex cursor-pointer items-center rounded-lg border border-app-border bg-app-surface px-4 py-2 text-sm font-medium text-app-text;
  @apply hover:bg-app-surface-muted disabled:cursor-not-allowed disabled:opacity-40;
}

.pager-desktop {
  @apply hidden w-full grid-cols-3 items-center sm:grid;
}

.summary {
  @apply text-sm text-app-text-muted;
}

.controls {
  @apply col-start-2 isolate inline-flex justify-self-center -space-x-px rounded-lg;
}

.arrow {
  @apply inline-flex cursor-pointer items-center border border-app-border bg-app-surface px-3 py-2.5 text-app-text-muted;
  @apply hover:bg-app-surface-muted focus:z-20 disabled:cursor-not-allowed disabled:opacity-40;
}

.arrow-prev {
  @apply rounded-l-lg;
}

.arrow-next {
  @apply rounded-r-lg;
}

.arrow-icon {
  @apply h-5 w-5;
}

.page-num {
  @apply inline-flex min-w-11 cursor-pointer items-center justify-center border border-app-border bg-app-surface px-4 py-2.5 text-sm font-medium text-app-text;
  @apply hover:bg-app-surface-muted focus:z-20;

  &.is-current {
    @apply z-10 border-app-primary bg-app-primary text-white hover:bg-app-primary;
  }
}

.ellipsis {
  @apply inline-flex min-w-11 items-center justify-center border border-app-border bg-app-surface px-4 py-2.5 text-sm font-medium text-app-text;
}

.pager.is-admin {
  .page-num.is-current {
    @apply border-app-primary bg-app-primary text-white hover:bg-app-primary;
  }
}
</style>
