// Global setup for contract tests.
//
// BFF has an OUTREACH_API_KEY gate in production. Contract tests exercise
// business logic, not auth plumbing (that's auth-matrix.test.ts). We run
// with BFF_AUTH_DISABLED=1 so tests don't have to smear x-api-key across
// every req() call. Individual tests that need to exercise the auth
// middleware explicitly must unset the flag in beforeEach.
//
// Why not per-test: the drift that motivated this (346 contract tests
// turned 401 after auth middleware was added) was caused by exactly that
// kind of fragile per-test setup. A global default is the correct
// enforcement point.

process.env.BFF_AUTH_DISABLED = '1'
// Contract tests run hundreds of requests per file → rate limiter (100/min)
// trips and returns 429 instead of exercising the handler. Disable for tests.
process.env.BFF_RATE_LIMIT_DISABLED = '1'

// Defense: many contract files mutate BFF_* env vars in beforeAll without
// restoring in afterAll. Sister files in the same vitest process then see
// clobbered values and fail with unexpected 401/429. beforeEach re-applies
// the safe defaults so each test starts in a known state.
// (Per docs/audits/2026-04-30-blind-spot-audit.md § A — root cause of cross-suite leak.)
import { beforeEach } from 'vitest'
beforeEach(() => {
  if (process.env.BFF_AUTH_DISABLED !== '1') process.env.BFF_AUTH_DISABLED = '1'
  if (process.env.BFF_RATE_LIMIT_DISABLED !== '1') process.env.BFF_RATE_LIMIT_DISABLED = '1'
})
// .env may set GO_SERVER_URL pointing at production. Contract tests exercise
// the legacy direct-DB path (which only fires when GO_SERVER_URL is unset)
// AND the Go-proxy path (which sets it explicitly per test). Strip globally
// so each test file decides explicitly. Otherwise tests for the legacy path
// silently round-trip through prod and fail.
// NB: deleting GO_SERVER_URL here doesn't stick — Vite's loadEnv
// repopulates it from .env when the test imports server.js. Each test
// file that needs the legacy direct-DB path must `delete process.env.GO_SERVER_URL`
// AFTER `await import('../../server.js')` in beforeAll. Tests that
// exercise the Go-proxy path set the URL explicitly.
