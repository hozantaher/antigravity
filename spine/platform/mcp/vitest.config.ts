import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'scrapers/**/*.ts', 'mcp-server/**/*.ts', 'desktop-extension/server/**/*.js', 'worker/**/*.ts'],
      exclude: ['**/types.ts', '**/index.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
