<script setup lang="ts">
// Internal component gallery. layout:false → no site Header/Footer (the chrome is shown
// as specimens instead, and the fixed control panel owns the top-right corner). ssr:false
// is set via routeRules in nuxt.config.
definePageMeta({ layout: false })
useHead({ title: 'Component Playground · Auction24' })

const { viewport } = usePlayground()
</script>

<template>
  <div class="pg-root">
    <PlaygroundControls />

    <div class="pg-shell">
      <header class="pg-hero">
        <p class="pg-hero-eyebrow">Auction24 · Design system</p>
        <h1 class="pg-hero-title">Component Playground</h1>
        <p class="pg-hero-lead">
          Every component used across the app — foundations, form controls, overlays, domain widgets and app chrome — in
          one place. Use the panel to switch language, surface and viewport.
        </p>
      </header>

      <main class="pg-main" :class="`is-${viewport}`">
        <PlaygroundFoundations />
        <PlaygroundForms />
        <PlaygroundOverlays />
        <PlaygroundDataDisplay />
        <PlaygroundDomain />
        <PlaygroundDeposit />
        <PlaygroundChrome />
        <PlaygroundHeadlessUi />
      </main>

      <footer class="pg-foot">
        <p>Auction24 component playground — internal tooling.</p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.pg-root {
  @apply min-h-screen bg-gray-50 text-gray-700 lg:pr-80;
}

.pg-shell {
  @apply mx-auto max-w-5xl px-4 pb-24 sm:px-6 lg:px-8;
}

.pg-hero {
  @apply py-10 md:py-14;
}

.pg-hero-eyebrow {
  @apply text-xs font-semibold tracking-wide text-app-red uppercase;
}

.pg-hero-title {
  @apply mt-2 text-32 font-bold text-gray-900 md:text-32;
}

.pg-hero-lead {
  @apply mt-3 max-w-2xl text-base text-gray-500 md:text-lg;
}

.pg-main {
  @apply mx-auto flex flex-col gap-14;

  &.is-mobile {
    @apply max-w-sm rounded-xl p-4 ring-1 ring-gray-200;
  }

  &.is-tablet {
    @apply max-w-3xl rounded-xl p-4 ring-1 ring-gray-200;
  }
}

.pg-foot {
  @apply mt-16 border-t border-gray-200 pt-6 text-sm text-gray-400;
}
</style>
