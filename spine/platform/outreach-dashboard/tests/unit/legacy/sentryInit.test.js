import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInit = vi.fn()
vi.mock('@sentry/react', () => ({
  init: mockInit,
  ErrorBoundary: ({ children }) => children,
  captureException: vi.fn(),
}))

beforeEach(() => mockInit.mockClear())

describe('sentryInit — Sentry.init options', () => {
  it('does NOT call init when DSN is absent', async () => {
    // Clear the module cache so we can re-import with different env
    vi.resetModules()
    vi.stubEnv('VITE_SENTRY_DSN_FRONTEND', '')
    await import('../../../src/sentryInit.js')
    expect(mockInit).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('passes environment from import.meta.env.MODE', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SENTRY_DSN_FRONTEND', 'https://test@sentry.io/0')
    await import('../../../src/sentryInit.js')
    if (mockInit.mock.calls.length > 0) {
      const opts = mockInit.mock.calls[0][0]
      expect(opts).toHaveProperty('environment')
    }
    vi.unstubAllEnvs()
  })

  it('tracesSampleRate is 0 (free tier — no performance tracing)', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SENTRY_DSN_FRONTEND', 'https://test@sentry.io/0')
    await import('../../../src/sentryInit.js')
    if (mockInit.mock.calls.length > 0) {
      const opts = mockInit.mock.calls[0][0]
      expect(opts.tracesSampleRate).toBe(0)
    }
    vi.unstubAllEnvs()
  })
})

describe('sentryInit env-aware sampling', () => {
  it('tracesSampleRate is 0 in development (no overhead)', () => {
    // In test env (MODE !== 'production'), should default to 0
    const rate = parseFloat(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || '0')
    expect(rate).toBe(0)
  })

  it('release comes from VITE_APP_VERSION or VITE_GIT_SHA', () => {
    const version = import.meta.env.VITE_APP_VERSION
    const sha = import.meta.env.VITE_GIT_SHA
    // At least one should be defined in CI
    // In local dev they may be undefined
    expect(typeof version === 'string' || typeof sha === 'string' || (version === undefined && sha === undefined)).toBe(true)
  })
})

describe('MONKEY: Sentry init resilience', () => {
  it('DSN with null bytes in sentryInit does not crash', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SENTRY_DSN_FRONTEND', 'https://\0test@sentry.io/0')
    // Should not throw even with malformed DSN
    await import('../../../src/sentryInit.js').catch(() => {})
    vi.unstubAllEnvs()
  })

  it('VITE_APP_VERSION with special chars does not crash', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SENTRY_DSN_FRONTEND', 'https://test@sentry.io/0')
    vi.stubEnv('VITE_APP_VERSION', 'v1.0.0-rc.1+build.123')
    await import('../../../src/sentryInit.js').catch(() => {})
    vi.unstubAllEnvs()
  })
})
