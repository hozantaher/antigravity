<script setup lang="ts">
// CompareDock only renders when something is being compared — seed a few placeholder
// picks while this page is mounted, then remove exactly those on leave (no real picks touched).
const { accepted } = useCookieConsent()
const { has, toggle, remove } = useCompare()
const compareSeed = ['pg-compare-1', 'pg-compare-2', 'pg-compare-3']

onMounted(() => compareSeed.forEach(id => !has(id) && toggle(id)))
onUnmounted(() => compareSeed.forEach(id => remove(id)))
</script>

<template>
  <PlaygroundSection id="chrome" title="App chrome" subtitle="Header, footer, menus & global bars.">
    <PlaygroundSpecimen
      name="Header"
      tag="chrome + Headless"
      description="Fixed nav — search, language, account. Position neutralised for preview."
    >
      <div class="pg-header-frame">
        <Header />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="Footer" tag="chrome">
      <div class="pg-footer-frame">
        <Footer />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="UserMenuAvatar"
      tag="chrome + Headless"
      surface="white"
      center
      description="Logged-out shows the sign-in icon; authenticated shows the avatar + Menu dropdown."
    >
      <UserMenuAvatar />
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="Language"
      tag="chrome + Headless"
      surface="white"
      description="Locale Listbox — interactive; switches the whole page."
    >
      <div class="pg-lang">
        <Language />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen
      name="CompareDock"
      tag="chrome"
      description="Floating compare dock — seeded with placeholder picks; position neutralised."
    >
      <div class="pg-dock-frame">
        <CompareDock />
      </div>
    </PlaygroundSpecimen>

    <PlaygroundSpecimen name="CookiesBar" tag="chrome" description="GDPR consent bar (fixed bottom).">
      <div v-if="!accepted" class="pg-cookie-frame">
        <CookiesBar />
      </div>
      <p v-else class="pg-hint">
        Consent already stored —
        <button type="button" class="app-link pg-link-btn" @click="accepted = false">preview the bar</button>.
      </p>
    </PlaygroundSpecimen>
  </PlaygroundSection>
</template>

<style scoped>
.pg-header-frame {
  @apply relative overflow-hidden rounded-lg border border-gray-200;
}

/* Neutralise the fixed positioning so the bar previews in place (app pattern: top-level :deep). */
.pg-header-frame :deep(.header) {
  @apply static;
}

.pg-header-frame :deep(.header-spacer) {
  @apply hidden;
}

.pg-footer-frame {
  @apply overflow-hidden rounded-lg border border-gray-200;
}

.pg-lang {
  @apply max-w-xs;
}

.pg-dock-frame {
  @apply relative overflow-hidden rounded-lg border border-gray-200 bg-gray-100 p-4;
}

.pg-dock-frame :deep(.compare-dock) {
  @apply static;
}

.pg-cookie-frame {
  @apply relative overflow-hidden rounded-lg border border-gray-200;
}

.pg-cookie-frame :deep(.bar) {
  @apply static;
}

.pg-hint {
  @apply text-sm text-gray-500;
}

.pg-link-btn {
  @apply cursor-pointer;
}
</style>
