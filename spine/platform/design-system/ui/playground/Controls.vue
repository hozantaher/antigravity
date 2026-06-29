<script setup lang="ts">
import type { PgSurface, PgViewport } from '~/features/platform/design-system/logic/usePlayground'

const { query, surface, viewport, showMeta } = usePlayground()
const { locale, locales, setLocale } = useI18n()

// setLocale (not a raw `locale` write) lazy-loads the target locale's messages and persists
// the cookie — binding v-model straight to `locale` shows untranslated keys (see Language.vue).
const currentLocale = computed({
  get: () => locale.value,
  set: code => setLocale(code),
})

const surfaceOptions: { value: PgSurface; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'gray', label: 'Gray' },
  { value: 'dark', label: 'Dark' },
]
const viewportOptions: { value: PgViewport; label: string }[] = [
  { value: 'mobile', label: 'Mobile' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'full', label: 'Full' },
]

// Open by default on the desktop rail, collapsed to a FAB below lg (where it overlays).
const isWide = useMediaQuery('(min-width: 1024px)')
const open = ref(true)
watch(isWide, w => (open.value = w), { immediate: true })

// Scroll-spy: highlight the topmost section currently in the upper viewport band.
const activeId = ref(PG_SECTIONS[0]?.id ?? '')
const visibleIds = reactive(new Set<string>())
const observers: Array<() => void> = []

onMounted(async () => {
  await nextTick()
  PG_SECTIONS.forEach(s => {
    const el = document.getElementById(s.id)
    if (!el) return
    const { stop } = useIntersectionObserver(
      el,
      entries => {
        const entry = entries[0]
        if (!entry) return
        if (entry.isIntersecting) visibleIds.add(s.id)
        else visibleIds.delete(s.id)
        const first = PG_SECTIONS.find(x => visibleIds.has(x.id))
        if (first) activeId.value = first.id
      },
      { rootMargin: '-15% 0px -75% 0px' },
    )
    observers.push(stop)
  })
})

onUnmounted(() => observers.forEach(stop => stop()))

const go = (id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (!isWide.value) open.value = false
}
</script>

<template>
  <div>
    <button v-if="!open" type="button" class="pg-fab" aria-label="Open playground controls" @click="open = true">
      <Icon name="heroicons-outline:adjustments" class="pg-fab-icon" />
    </button>

    <div v-if="open" class="pg-backdrop" @click="open = false" />

    <aside v-if="open" class="pg-panel">
      <div class="pg-panel-head">
        <div class="pg-panel-title">
          <Icon name="heroicons-outline:adjustments" class="pg-panel-title-icon" />
          <span>Controls</span>
        </div>
        <button type="button" class="app-icon-btn pg-close" aria-label="Collapse" @click="open = false">
          <Icon name="heroicons-outline:x" class="pg-close-icon" />
        </button>
      </div>

      <div class="pg-panel-body">
        <div class="pg-group">
          <input v-model="query" type="search" class="pg-search" placeholder="Filter components…" />
        </div>

        <div class="pg-group">
          <p class="pg-group-label">Sections</p>
          <nav class="pg-nav">
            <button
              v-for="s in PG_SECTIONS"
              :key="s.id"
              type="button"
              class="pg-nav-item"
              :class="{ 'is-active': activeId === s.id }"
              @click="go(s.id)"
            >
              <Icon :name="s.icon" class="pg-nav-icon" />
              <span>{{ s.label }}</span>
            </button>
          </nav>
        </div>

        <div class="pg-group">
          <p class="pg-group-label">Language</p>
          <select v-model="currentLocale" class="pg-select">
            <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.name }}</option>
          </select>
        </div>

        <div class="pg-group">
          <p class="pg-group-label">Surface</p>
          <div class="pg-seg">
            <button
              v-for="opt in surfaceOptions"
              :key="opt.value"
              type="button"
              class="pg-seg-btn"
              :class="{ 'is-active': surface === opt.value }"
              @click="surface = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div class="pg-group">
          <p class="pg-group-label">Viewport</p>
          <div class="pg-seg">
            <button
              v-for="opt in viewportOptions"
              :key="opt.value"
              type="button"
              class="pg-seg-btn"
              :class="{ 'is-active': viewport === opt.value }"
              @click="viewport = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div class="pg-group">
          <BaseCheckbox :value="showMeta" label="Show props" @update:value="showMeta = $event" />
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.pg-fab {
  @apply fixed top-4 right-4 z-10 flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-app-red text-white shadow-lg;
  @apply hover:bg-app-red/90 focus:ring-2 focus:ring-app-red/50 focus:ring-offset-2 focus:outline-none;
}

.pg-fab-icon {
  @apply h-6 w-6;
}

.pg-backdrop {
  @apply fixed inset-0 z-10 bg-black/30 lg:hidden;
}

.pg-panel {
  @apply fixed top-4 right-4 z-10 flex max-h-90vh w-72 max-w-90vw flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl ring-1 ring-black/5;
}

.pg-panel-head {
  @apply flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3;
}

.pg-panel-title {
  @apply flex items-center gap-2 text-sm font-semibold text-gray-900;
}

.pg-panel-title-icon {
  @apply h-5 w-5 text-app-red;
}

.pg-close {
  @apply p-1 text-gray-400 hover:text-gray-600;
}

.pg-close-icon {
  @apply h-5 w-5;
}

.pg-panel-body {
  @apply flex flex-1 flex-col gap-4 overflow-y-auto p-4;
}

.pg-group {
  @apply flex flex-col gap-2;
}

.pg-group-label {
  @apply text-xs font-semibold tracking-wide text-gray-400 uppercase;
}

.pg-search {
  @apply w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 shadow-sm;
  @apply focus:border-app-red focus:ring-1 focus:ring-app-red/40 focus:outline-none;
}

.pg-nav {
  @apply flex flex-col gap-0.5;
}

.pg-nav-item {
  @apply flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-gray-600;
  @apply hover:bg-gray-100;

  &.is-active {
    @apply bg-app-red/10 font-medium text-app-red;
  }
}

.pg-nav-icon {
  @apply h-4 w-4 shrink-0;
}

.pg-select {
  @apply w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-700 shadow-sm;
  @apply focus:border-app-red focus:outline-none;
}

.pg-seg {
  @apply flex overflow-hidden rounded-lg border border-gray-300;
}

.pg-seg-btn {
  @apply flex-1 cursor-pointer border-r border-gray-300 bg-white px-2 py-1.5 text-center text-xs font-medium text-gray-600;
  @apply hover:bg-gray-50 last:border-r-0;

  &.is-active {
    @apply bg-app-red text-white hover:bg-app-red;
  }
}
</style>
