import { describe, it, expect, vi } from 'vitest'
import { useAdminPagedResource } from '~/features/platform/admin/logic/useAdminPagedResource'

// Proves the nuxt environment: native useState + a stubbed $fetch global driving a real composable.
describe('nuxt env smoke', () => {
  it('useState resolves and is reactive', () => {
    const s = useState('smoke', () => 42)
    expect(s.value).toBe(42)
  })

  it('useAdminPagedResource stores fetched page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ items: [{ id: 'a' }], total: 1 })
    vi.stubGlobal('$fetch', fetchMock)
    const r = useAdminPagedResource<{ id: string }, { page: number; pageSize: number }>('smoke:res', '/api/x')
    await r.fetchPage({ page: 1, pageSize: 10 })
    expect(r.items.value).toEqual([{ id: 'a' }])
    expect(r.total.value).toBe(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/x', { query: { page: 1, pageSize: 10 } })
  })
})
