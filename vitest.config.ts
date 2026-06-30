import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // .mjs (ne .ts): soubor je mimo tsconfig `include`; Vite 8/oxc by na .ts selhal FS lookupem
    // tsconfigu ("[TSCONFIG_ERROR] Tsconfig not found") a shodil CELÝ suite. Plain ESM jede bez tsconfigu.
    setupFiles: ['./vitest.setup.mjs'],
    environment: 'node',
  },
});
