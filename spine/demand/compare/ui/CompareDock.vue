<script lang="ts" setup>
const { t } = useI18n()
const route = useRoute()
const { ids, remove, clear, maxItems } = useCompare()
const { accepted } = useCookieConsent()
const { getSearchImage } = useImageProcessing()

// no_prefix strategy → the compare path is literal in every locale.
const onComparePage = computed(() => route.path === '/compare')
const compareHref = computed(() => (ids.value.length ? `/compare?ids=${ids.value.join(',')}` : '/compare'))

// Resolve {title,image} for thumbnails lazily and cache by id so re-renders don't refetch.
const thumbs = ref(new Map<string, { title: string; image: string }>())
const refresh = async (): Promise<void> => {
  const missing = ids.value.filter(id => !thumbs.value.has(id))
  if (!missing.length) return
  const fetched = await Promise.all(
    missing.map(async id => {
      const item = await fetchItemOrNull(id)
      return item ? ([id, { title: item.title, image: item.image }] as const) : null
    }),
  )
  const next = new Map(thumbs.value)
  for (const entry of fetched) if (entry) next.set(entry[0], entry[1])
  thumbs.value = next
}
watch(ids, refresh, { immediate: true })
</script>

<template>
  <Transition name="dock">
    <div
      v-if="ids.length && !onComparePage"
      class="compare-dock"
      :class="{ 'is-cookie-bar': !accepted }"
      role="region"
      :aria-label="t('compare.title')"
    >
      <span class="count">{{ t('compare.count', { count: ids.length, max: maxItems }) }}</span>
      <ul class="thumbs">
        <li v-for="id in ids" :key="id" class="thumb-item">
          <img
            v-if="thumbs.get(id)"
            :src="getSearchImage(thumbs.get(id)!.image)"
            :alt="thumbs.get(id)!.title"
            class="thumb"
            loading="lazy"
            decoding="async"
          />
          <span v-else class="thumb-ph" aria-hidden="true" />
          <button type="button" class="thumb-remove" :aria-label="t('compare.remove')" @click="remove(id)">
            <Icon name="heroicons-outline:x" class="thumb-remove-icon" />
          </button>
        </li>
      </ul>
      <NuxtLinkLocale :to="compareHref" class="open-link">{{ t('compare.open') }}</NuxtLinkLocale>
      <button type="button" class="dock-clear" @click="clear">{{ t('compare.clear') }}</button>
    </div>
  </Transition>
</template>

<style scoped>
.compare-dock {
  @apply fixed right-5 bottom-5 z-40 flex items-center gap-3 rounded-xl border border-app-border bg-app-surface p-3 shadow-xl max-md:right-3 max-md:bottom-3 max-md:left-3 max-md:flex-wrap;

  &.is-cookie-bar {
    @apply bottom-24 max-md:bottom-52;
  }
}

.count {
  @apply text-sm font-semibold text-app-text-muted max-md:w-full;
}

.thumbs {
  @apply flex items-center gap-2;
}

.thumb-item {
  @apply relative;
}

.thumb,
.thumb-ph {
  @apply block h-11 w-11 rounded-lg bg-app-surface-muted object-cover;
}

.thumb-remove {
  @apply absolute -top-1.5 -right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-app-border bg-app-surface text-app-text-muted;
}

.thumb-remove-icon {
  @apply h-3 w-3;
}

.open-link {
  @apply rounded-lg bg-app-primary px-4 py-2 font-bold whitespace-nowrap text-white hover:bg-app-primary-hover;
}

.dock-clear {
  @apply cursor-pointer rounded-lg px-3 py-2 font-medium whitespace-nowrap text-app-text-muted hover:text-app-red;
}

.dock-enter-active,
.dock-leave-active {
  @apply transition duration-300;
}

.dock-enter-from,
.dock-leave-to {
  @apply translate-y-full opacity-0;
}
</style>
