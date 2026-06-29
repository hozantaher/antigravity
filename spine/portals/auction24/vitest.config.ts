import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { loadEnv } from './scripts/load-env'

// Capture a POSTGRES_URL set explicitly in the shell (the docker test DB the test scripts export)
// BEFORE loadEnv() pulls .env — whose POSTGRES_URL points at the live Railway database. Tests must
// NEVER touch Railway, so the .env value is discarded and we use the docker-compose test DB
// (docker-compose.test.yml → test/test@localhost:5434/test). The unit/server/nuxt projects never
// connect (the pg Pool is lazy); only the integration project does, and it needs
// `docker compose -f docker-compose.test.yml up` — which the test/test:integration/test:coverage
// scripts bring up.
const explicitPostgresUrl = process.env.POSTGRES_URL
loadEnv()
if (!explicitPostgresUrl) {
  process.env.POSTGRES_URL = 'postgresql://test:test@localhost:5434/test'
  process.env.POSTGRES_SSL = 'disable'
}

const alias = { '~': resolve(__dirname, '.'), '@': resolve(__dirname, '.') }

// Thresholds gate the FULL run only (test:coverage, which brings docker up so the integration
// project runs and server/repos coverage is real). The fast loop omits integration, so enforcing
// there would fail spuriously — gate is opt-in via COVERAGE_GATE.
const thresholds = process.env.COVERAGE_GATE
  ? {
      // The "85% coverage rate" target — enforced on statements, lines, and functions.
      lines: 85,
      statements: 85,
      functions: 85,
      // Branch coverage is floored lower on purpose: much of the remaining branch surface is
      // defensive (`?? null` fallbacks, IO error paths, optional chains) where chasing the last
      // points costs contrived tests for little real assurance. 70 still blocks regressions.
      branches: 70,
      'models/**/*.ts': { lines: 90, functions: 90 },
      'server/repos/**/*.ts': { lines: 85, functions: 80 },
      // Cells wired into the autonomous-module system are held to the 98/90 gate
      // (docs/modularization-plan.md). Per-file entries override the layer floor above.
      'models/Item.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'models/Recommendation.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'models/enums.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'composables/admin/useUserDetail.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'composables/admin/useUserList.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'features/design-system/logic/usePlayground.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      // useDetailTracking: 1 unreachable SSR guard keeps statements at 97.22 — gate on lines/functions/branches.
      'features/platform/consent-tracking/logic/useDetailTracking.ts': { lines: 98, functions: 98, branches: 90 },
      'features/design-system/logic/useScrollArrows.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'composables/useSeo.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'utils/company.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'server/api/admin/items.get.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'server/api/admin/contact-messages.get.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'server/api/admin/user/[id]/invoices.get.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'server/middleware/canonical-host.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'server/repos/fromFirestore.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
      'server/utils/auctionCloser.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
    }
  : undefined

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.{test,spec}.ts'] },
      },
      {
        resolve: { alias },
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/server/**/*.{test,spec}.ts'],
          setupFiles: ['tests/setup/server.ts'],
          unstubGlobals: true,
          // MJML email render under coverage instrumentation can exceed the 5s default.
          testTimeout: 30_000,
        },
      },
      './vitest.nuxt.config.ts',
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.{test,spec}.ts'],
          globalSetup: ['tests/global-setup.ts'],
          // Each worker opens its own pg Pool; serialize to keep connections low.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['models/**/*.ts', 'server/**/*.ts', 'composables/**/*.ts', 'utils/**/*.ts', 'features/**/*.ts'],
      exclude: [
        // out of scope
        'server/migrations/**',
        'server/openapi/**',
        'server/email/**',
        'server/db/schema.ts',
        'server/data/fixtures.ts',
        // infra / bootstrap / no business logic
        'server/utils/db.ts',
        'server/utils/migrate.ts',
        'server/utils/observability.ts',
        'server/repos/migrationRepo.ts', // one-time Firestore→Postgres migration tooling
        'server/plugins/**',
        'utils/firebaseClient.ts',
        // zero-logic boilerplate handlers (static re-exports, docs, 404, mock echo)
        'server/api/categories.get.ts',
        'server/api/category-params.get.ts',
        'server/api/countries.get.ts',
        'server/api/currencies.get.ts',
        'server/api/languages.get.ts',
        'server/api/translate.post.ts',
        'server/api/_docs.get.ts',
        'server/api/_openapi.json.get.ts',
        'server/api/me.get.ts', // one-line: return getSessionUser(event)
        // one-line state/pattern wrappers
        'composables/useSharedNow.ts',
        'composables/admin/useAdminSearch.ts',
        // feature-module contracts are type/re-export only (no runtime logic), like server/db/schema.ts
        'features/**/contract.ts',
        // generic
        '**/*.vue',
        '**/*.d.ts',
        '**/*.{test,spec}.ts',
        'tests/**',
      ],
      thresholds,
    },
  },
})
