import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import { useCompare, resetCompare } from '~/features/demand/compare/logic/useCompare'

// useToast (vue-toastification) and useI18n are non-bootstrap app utilities, so stubbing them lets
// the composable's pure list logic run in isolation. The singleton state is reset per test below.
const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
mockNuxtImport('useI18n', () => () => ({ t: (key: string) => key }))

// useTracking is a real composable; stub it so we can assert the recommendation signal fires on add
// without driving the consent/cookie machinery.
const { compareAdd } = vi.hoisted(() => ({ compareAdd: vi.fn() }))
mockNuxtImport('useTracking', () => () => ({ compareAdd }))

const KEY = 'auction24:compare-ids'

beforeEach(() => {
  resetCompare()
  localStorage.clear()
  vi.clearAllMocks()
})

describe('useCompare', () => {
  it('toggles an id in and back out, persisting to localStorage', () => {
    const { has, toggle } = useCompare()
    expect(toggle('a')).toBe('added')
    expect(has('a')).toBe(true)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['a'])
    expect(toggle('a')).toBe('removed')
    expect(has('a')).toBe(false)
  })

  it('caps the list at 4 items', () => {
    const { toggle, ids } = useCompare()
    expect(['a', 'b', 'c', 'd'].map(toggle)).toEqual(['added', 'added', 'added', 'added'])
    expect(toggle('e')).toBe('full')
    expect(ids.value).toEqual(['a', 'b', 'c', 'd'])
  })

  it('fires the matching toast per result', () => {
    const { toggleWithToast } = useCompare()
    toggleWithToast('a')
    expect(toast.success).toHaveBeenCalledOnce()
    toggleWithToast('a')
    expect(toast.info).toHaveBeenCalledOnce()
    for (const id of ['b', 'c', 'd', 'a']) toggleWithToast(id)
    toggleWithToast('z')
    expect(toast.warning).toHaveBeenCalledOnce()
  })

  it('remove is idempotent', () => {
    const { toggle, remove, has } = useCompare()
    toggle('a')
    remove('missing')
    expect(has('a')).toBe(true)
    remove('a')
    expect(has('a')).toBe(false)
  })

  it('clear empties the list and storage', () => {
    const { toggle, clear, ids } = useCompare()
    toggle('a')
    toggle('b')
    clear()
    expect(ids.value).toEqual([])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([])
  })

  it('resetCompare wipes state and removes the storage key', () => {
    const { toggle, ids } = useCompare()
    toggle('a')
    resetCompare()
    expect(ids.value).toEqual([])
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('syncs from a storage event fired by another tab', () => {
    const { ids } = useCompare()
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: JSON.stringify(['x', 'y']) }))
    expect(ids.value).toEqual(['x', 'y'])
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }))
    expect(ids.value).toEqual([])
  })

  it('fires the compareAdd tracking signal only on add, not on remove or full', () => {
    const { toggle } = useCompare()
    toggle('a')
    expect(compareAdd).toHaveBeenCalledExactlyOnceWith('a')
    toggle('a') // removed — no signal
    for (const id of ['b', 'c', 'd', 'e']) toggle(id) // 4 add + 1 full
    expect(compareAdd).toHaveBeenCalledTimes(5) // a, b, c, d (e is full → skipped)
  })

  it('ignores storage events for unrelated keys and bad payloads', () => {
    const { toggle, ids } = useCompare()
    toggle('a')
    // wrong key → handler returns early, state untouched
    window.dispatchEvent(new StorageEvent('storage', { key: 'other-key', newValue: JSON.stringify(['z']) }))
    expect(ids.value).toEqual(['a'])
    // corrupted JSON for our key → catch swallows, state untouched
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: '{bad json' }))
    expect(ids.value).toEqual(['a'])
  })

  it('sanitizes a cross-tab payload: drops non-strings and caps at 4', () => {
    const { ids } = useCompare()
    const payload = JSON.stringify(['a', 1, 'b', null, 'c', 'd', 'e', 'f'])
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: payload }))
    expect(ids.value).toEqual(['a', 'b', 'c', 'd'])
  })

  it('sanitizes a non-array cross-tab payload to an empty list', () => {
    const { ids } = useCompare()
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: JSON.stringify({ not: 'an array' }) }))
    expect(ids.value).toEqual([])
  })

  it('swallows localStorage write failures (private mode) during persist', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    const { toggle, has } = useCompare()
    expect(() => toggle('a')).not.toThrow()
    expect(has('a')).toBe(true) // in-memory state still updated
    setItem.mockRestore()
  })

  it('swallows localStorage.removeItem failures during resetCompare', () => {
    const { toggle } = useCompare()
    toggle('a')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    expect(() => resetCompare()).not.toThrow()
    removeItem.mockRestore()
  })

  it('hydrates from localStorage on mount and is idempotent on a second mount', async () => {
    // `hydrate` latches its module `hydrated` flag the first time any useCompare() runs (VueUse's
    // tryOnMounted invokes immediately outside a component), so a stored value only reads through on
    // a fresh module graph. Reset to exercise the real hydrate-read + assignment path.
    localStorage.setItem(KEY, JSON.stringify(['p', 'q']))
    vi.resetModules()
    const fresh = await import('~/features/demand/compare/logic/useCompare')
    let api: ReturnType<typeof fresh.useCompare> | undefined
    await mountSuspended(
      defineComponent({
        setup() {
          api = fresh.useCompare()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    expect(api?.ids.value).toEqual(['p', 'q'])

    // Second mount on the same fresh module: hydrated flag already set → early return, so changing
    // localStorage does not re-read.
    localStorage.setItem(KEY, JSON.stringify(['changed']))
    await mountSuspended(
      defineComponent({
        setup() {
          fresh.useCompare()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    expect(api?.ids.value).toEqual(['p', 'q'])
    vi.resetModules()
  })

  it('keeps the empty default when stored JSON is corrupted (fresh module, hydrate catch)', async () => {
    // hydrate latches its `hydrated` flag true after the mount above, so re-mounting can't re-enter
    // the read. Reset the module registry to get a fresh singleton whose first hydrate sees a
    // corrupted entry and falls into the catch, keeping the empty default.
    localStorage.setItem(KEY, '{not valid')
    vi.resetModules()
    const fresh = await import('~/features/demand/compare/logic/useCompare')
    let api: ReturnType<typeof fresh.useCompare> | undefined
    await mountSuspended(
      defineComponent({
        setup() {
          api = fresh.useCompare()
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    expect(api?.ids.value).toEqual([])
    vi.resetModules() // don't leak the reset module graph into other suites
  })

  it('exposes maxItems and a readonly ids ref', () => {
    const { maxItems, ids } = useCompare()
    expect(maxItems).toBe(4)
    expect(ids.value).toEqual([])
  })

  it('persist no-ops under SSR (window undefined) without touching localStorage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { toggle, has } = useCompare()
    vi.stubGlobal('window', undefined)
    try {
      expect(() => toggle('a')).not.toThrow()
      expect(has('a')).toBe(true) // in-memory ref still updates
      expect(setItem).not.toHaveBeenCalled() // SSR guard short-circuits before localStorage
    } finally {
      vi.unstubAllGlobals()
      setItem.mockRestore()
    }
  })

  it('resetCompare clears state but skips storage removal under SSR (window undefined)', () => {
    const { toggle, ids } = useCompare()
    toggle('a')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    vi.stubGlobal('window', undefined)
    try {
      resetCompare()
      expect(ids.value).toEqual([]) // state wiped regardless of environment
      expect(removeItem).not.toHaveBeenCalled() // SSR guard short-circuits before localStorage
    } finally {
      vi.unstubAllGlobals()
      removeItem.mockRestore()
    }
  })
})
