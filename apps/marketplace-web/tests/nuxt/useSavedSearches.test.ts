import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import useSavedSearches from '~/features/demand/saved-search/logic/useSavedSearches'
import type { SavedSearch } from '~/models'

// useToast (vue-toastification) and useI18n are non-bootstrap app utilities; stub them so the
// composable's CRUD logic runs in isolation (mirrors tests/nuxt/useCompare.test.ts).
const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
mockNuxtImport('useI18n', () => () => ({ t: (key: string) => key }))

const ss = (over: Partial<SavedSearch> = {}): SavedSearch =>
  ({
    id: 'ss1',
    userId: 'u1',
    name: 'BMW',
    query: { q: 'bmw' },
    alertEnabled: true,
    createdAt: 0,
    ...over,
  }) as SavedSearch

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the shared useState buckets between tests so state doesn't leak across cases.
  useSavedSearches().dispose()
})

describe('useSavedSearches', () => {
  it('fetchPage loads the paginated list and stores items + total', async () => {
    const f = vi.fn().mockResolvedValue({ items: [ss(), ss({ id: 'ss2' })], total: 2, page: 1, pageSize: 10 })
    vi.stubGlobal('$fetch', f)

    const api = useSavedSearches()
    await api.fetchPage(1)

    expect(f).toHaveBeenCalledWith('/api/saved-searches', { query: { page: 1, pageSize: 10 } })
    expect(api.items.value.map(s => s.id)).toEqual(['ss1', 'ss2'])
    expect(api.total.value).toBe(2)
    expect(api.loading.value).toBe(false)
  })

  it('create POSTs name+query and refreshes the list', async () => {
    const created = ss({ id: 'ssNew', name: 'Audi' })
    const f = vi
      .fn()
      .mockResolvedValueOnce(created) // POST
      .mockResolvedValueOnce({ items: [created], total: 1, page: 1, pageSize: 10 }) // refresh
    vi.stubGlobal('$fetch', f)

    const api = useSavedSearches()
    const res = await api.create('Audi', { q: 'audi' })

    expect(f).toHaveBeenNthCalledWith(1, '/api/saved-searches', {
      method: 'POST',
      body: { name: 'Audi', query: { q: 'audi' }, alertEnabled: true },
    })
    expect(res).toMatchObject({ id: 'ssNew' })
    expect(api.items.value.map(s => s.id)).toEqual(['ssNew'])
  })

  it('create returns null and keeps state on failure', async () => {
    const f = vi.fn().mockRejectedValue(new Error('boom'))
    vi.stubGlobal('$fetch', f)

    const api = useSavedSearches()
    const res = await api.create('Audi', { q: 'audi' })
    expect(res).toBeNull()
  })

  it('remove DELETEs by id and refreshes', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(undefined) // DELETE
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 10 }) // refresh
    vi.stubGlobal('$fetch', f)

    const api = useSavedSearches()
    api.items.value = [ss()]
    await api.remove('ss1')

    expect(f).toHaveBeenNthCalledWith(1, '/api/saved-searches/ss1', { method: 'DELETE' })
    expect(api.items.value).toEqual([])
  })

  it('toggleAlert PATCHes the flag and swaps the row in place (no refetch)', async () => {
    const updated = ss({ alertEnabled: false })
    const f = vi.fn().mockResolvedValue(updated)
    vi.stubGlobal('$fetch', f)

    const api = useSavedSearches()
    api.items.value = [ss({ alertEnabled: true })]
    await api.toggleAlert('ss1', false)

    expect(f).toHaveBeenCalledWith('/api/saved-searches/ss1', { method: 'PATCH', body: { alertEnabled: false } })
    expect(api.items.value[0]?.alertEnabled).toBe(false)
    // Only the PATCH ran — no list refetch.
    expect(f).toHaveBeenCalledTimes(1)
  })
})
