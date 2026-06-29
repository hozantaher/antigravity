import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

import { useCookieConsent } from '~/features/platform/consent-tracking/logic/useCookieConsent'
import useInit from '~/features/platform/core/logic/useInit'

const spies = vi.hoisted(() => ({
  gtag: vi.fn(),
  initialize: vi.fn(),
  init: vi.fn().mockResolvedValue(null),
  fetchCategories: vi.fn().mockResolvedValue(undefined),
  fetchCategoryParams: vi.fn().mockResolvedValue(undefined),
  fetchLanguages: vi.fn().mockResolvedValue(undefined),
  fetchCountries: vi.fn().mockResolvedValue(undefined),
  fetchCurrencies: vi.fn().mockResolvedValue(undefined),
}))

mockNuxtImport('useGtag', () => () => ({ gtag: spies.gtag, initialize: spies.initialize }))
mockNuxtImport('useUser', () => () => ({ init: spies.init }))
mockNuxtImport('useLanguages', () => () => ({ fetchLanguages: spies.fetchLanguages }))
mockNuxtImport('useCountries', () => () => ({ fetchCountries: spies.fetchCountries }))
mockNuxtImport('useCurrencies', () => () => ({ fetchCurrencies: spies.fetchCurrencies }))
mockNuxtImport('useCategories', () => () => ({
  fetchCategories: spies.fetchCategories,
  fetchCategoryParams: spies.fetchCategoryParams,
}))
vi.mock('~/features/platform/auth-account/logic/state', () => ({ whenAuthReady: vi.fn().mockResolvedValue(undefined) }))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('useCookieConsent', () => {
  it('accepts consent but skips analytics when gtag is unconfigured', () => {
    ;(useRuntimeConfig().public as Record<string, unknown>).gtag = undefined
    const c = useCookieConsent()
    c.accept()
    expect(c.accepted.value).toBe(true)
    expect(spies.gtag).not.toHaveBeenCalled()
  })

  it('initializes gtag and grants consent when configured', () => {
    ;(useRuntimeConfig().public as Record<string, unknown>).gtag = { id: 'G-XXX' }
    const c = useCookieConsent()
    c.accept()
    expect(spies.initialize).toHaveBeenCalled()
    expect(spies.gtag).toHaveBeenCalledWith(
      'consent',
      'update',
      expect.objectContaining({ analytics_storage: 'granted' }),
    )
  })
})

describe('useInit', () => {
  it('fetchDataSync awaits categories but kicks off the user fetch without blocking (client)', async () => {
    await useInit().fetchDataSync()
    expect(spies.fetchCategories).toHaveBeenCalled()
    // The user fetch is deliberately detached (not awaited) so it can't block hydration; flush the
    // microtask chain (whenAuthReady -> userInit) before asserting it was kicked off.
    await Promise.resolve()
    await Promise.resolve()
    expect(spies.init).toHaveBeenCalled()
  })

  it('fetchDataSync swallows a failed categories fetch (warnFetch catch path)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    spies.fetchCategories.mockRejectedValueOnce(new Error('boom'))
    await expect(useInit().fetchDataSync()).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalledWith('[init] failed to load categories', expect.any(Error))
    await Promise.resolve()
    await Promise.resolve()
    expect(spies.init).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('fetchDataAsync fires the deferred reference-data loads', () => {
    useInit().fetchDataAsync()
    expect(spies.fetchLanguages).toHaveBeenCalled()
    expect(spies.fetchCountries).toHaveBeenCalled()
    expect(spies.fetchCurrencies).toHaveBeenCalled()
    expect(spies.fetchCategoryParams).toHaveBeenCalled()
  })

  it('fetchDataAsync swallows every failing deferred load (all warnFetch catch paths)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    spies.fetchLanguages.mockRejectedValueOnce(new Error('lang'))
    spies.fetchCountries.mockRejectedValueOnce(new Error('country'))
    spies.fetchCurrencies.mockRejectedValueOnce(new Error('currency'))
    spies.fetchCategoryParams.mockRejectedValueOnce(new Error('params'))
    expect(() => useInit().fetchDataAsync()).not.toThrow()
    // Let the rejected promises settle so the .catch handlers run.
    await Promise.resolve()
    await Promise.resolve()
    expect(errSpy).toHaveBeenCalledWith('[init] failed to load languages', expect.any(Error))
    expect(errSpy).toHaveBeenCalledWith('[init] failed to load countries', expect.any(Error))
    expect(errSpy).toHaveBeenCalledWith('[init] failed to load currencies', expect.any(Error))
    expect(errSpy).toHaveBeenCalledWith('[init] failed to load categoryParams', expect.any(Error))
    errSpy.mockRestore()
  })
})

// state.ts is module-mocked above for the useInit suite; exercise the REAL module here via
// importActual so its markAuthReady/whenAuthReady branches get covered.
describe('auth/state (real module)', () => {
  it('markAuthReady resolves whenAuthReady, is idempotent, and clears the resolver', async () => {
    const state = await vi.importActual<typeof import('~/features/platform/auth-account/logic/state')>(
      '~/features/platform/auth-account/logic/state',
    )

    let resolved = false
    const promise = state.whenAuthReady().then(() => {
      resolved = true
    })

    // Same promise instance returned on every call.
    expect(state.whenAuthReady()).toBe(state.whenAuthReady())
    expect(resolved).toBe(false)

    state.markAuthReady()
    await promise
    expect(resolved).toBe(true)

    // Second call hits the `if (ready) return` early-exit branch (resolver already nulled).
    expect(() => state.markAuthReady()).not.toThrow()
    await expect(state.whenAuthReady()).resolves.toBeUndefined()
  })
})
