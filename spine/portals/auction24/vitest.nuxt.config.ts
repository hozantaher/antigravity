import { defineVitestConfig } from '@nuxt/test-utils/config'

// Composable + component tests run in a real Nuxt environment so Nuxt/VueUse auto-imports
// (useState, useRuntimeConfig, navigateTo, nested project composables) resolve natively.
// Kept in its own config so the Nuxt-Vite build is self-contained; referenced by path from
// the root vitest.config.ts projects array.
export default defineVitestConfig({
  test: {
    name: 'nuxt',
    environment: 'nuxt',
    include: ['tests/nuxt/**/*.{test,spec}.ts'],
    setupFiles: ['tests/setup/nuxt.ts'],
    environmentOptions: { nuxt: { domEnvironment: 'happy-dom' } },
    // Cold Nuxt-env boot (full app transform) can exceed the 10s default hook timeout on a
    // cold/contended machine, skipping the suite. Give the setup room so runs are deterministic.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
})
