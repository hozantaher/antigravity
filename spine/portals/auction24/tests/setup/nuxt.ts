import { beforeEach, vi } from 'vitest'

// Composables call $fetch (a Nuxt/Nitro global). Default it to a stub so a test that doesn't
// explicitly configure it never hits the network; tests override via vi.stubGlobal('$fetch', fn).
beforeEach(() => {
  vi.stubGlobal('$fetch', vi.fn())
})
