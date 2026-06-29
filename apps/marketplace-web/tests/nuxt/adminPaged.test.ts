import { beforeEach, describe, expect, it, vi } from 'vitest'

import useApiTokens from '~/features/platform/api-tokens/logic/useApiTokens'
import useItemList from '~/features/platform/admin/logic/useItemList'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

beforeEach(() => vi.clearAllMocks())

describe('useApiTokens', () => {
  it('creates a token, toasts success, and returns the raw value', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 't1', token: 'grg_x' }))
    const created = await useApiTokens().createToken('CI')
    expect(created).toMatchObject({ token: 'grg_x' })
    expect(toast.success).toHaveBeenCalled()
  })

  it('toasts the error message and returns null on failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { statusMessage: 'nope' } }))
    const created = await useApiTokens().createToken('CI')
    expect(created).toBeNull()
    expect(toast.error).toHaveBeenCalledWith('nope')
  })

  it('deletes a token', async () => {
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    await useApiTokens().deleteToken('t1')
    expect(f).toHaveBeenCalledWith('/api/admin/api-tokens/t1', { method: 'DELETE' })
    expect(toast.success).toHaveBeenCalled()
  })

  it('surfaces a delete error as a toast (with fallback message)', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({}))
    await useApiTokens().deleteToken('t1')
    expect(toast.error).toHaveBeenCalledWith('Something went wrong')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('refresh re-fetches the last params after a create, and exposes paged state', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 't1' }], total: 1 }) // fetchPage
      .mockResolvedValueOnce({ id: 't2', token: 'grg_y' }) // createToken POST
      .mockResolvedValueOnce({ items: [{ id: 't1' }, { id: 't2' }], total: 2 }) // refresh
    vi.stubGlobal('$fetch', f)

    const api = useApiTokens()
    await api.fetchPage({ page: 1, pageSize: 10 })
    expect(api.items.value).toHaveLength(1)
    expect(api.total.value).toBe(1)
    expect(api.loading.value).toBe(false)

    const created = await api.createToken('CI2')
    expect(created).toMatchObject({ token: 'grg_y' })
    expect(api.total.value).toBe(2)
    expect(api.items.value).toHaveLength(2)
    expect(api.dispose()).toBeUndefined()
  })
})

describe('useItemList', () => {
  it('toggles visibility via PUT and toasts', async () => {
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    await useItemList().updateVisibility({ id: 'i1', hidden: false } as never)
    expect(f).toHaveBeenCalledWith('/api/admin/item/i1', { method: 'PUT', body: { hidden: true } })
    expect(toast.success).toHaveBeenCalled()
  })

  it('deletes an item via DELETE', async () => {
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    await useItemList().deleteItem({ id: 'i1' } as never)
    expect(f).toHaveBeenCalledWith('/api/admin/item/i1', { method: 'DELETE' })
  })

  it('surfaces a delete error as a toast', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusMessage: 'boom' }))
    await useItemList().deleteItem({ id: 'i1' } as never)
    expect(toast.error).toHaveBeenCalledWith('boom')
  })

  it('toggles a hidden item back to visible (hidden: true -> false)', async () => {
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    await useItemList().updateVisibility({ id: 'i2', hidden: true } as never)
    expect(f).toHaveBeenCalledWith('/api/admin/item/i2', { method: 'PUT', body: { hidden: false } })
    expect(toast.success).toHaveBeenCalled()
  })

  it('surfaces a visibility error as a toast and skips success', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { statusMessage: 'denied' } }))
    await useItemList().updateVisibility({ id: 'i1', hidden: false } as never)
    expect(toast.error).toHaveBeenCalledWith('denied')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('exposes paged state via fetchPage/refresh and a noop dispose', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'i1' }], total: 1 }) // fetchPage
      .mockResolvedValueOnce(undefined) // deleteItem DELETE
      .mockResolvedValueOnce({ items: [], total: 0 }) // refresh
    vi.stubGlobal('$fetch', f)

    const list = useItemList()
    await list.fetchPage({ page: 1, pageSize: 12 })
    expect(list.items.value).toHaveLength(1)
    expect(list.total.value).toBe(1)
    expect(list.loading.value).toBe(false)

    await list.deleteItem({ id: 'i1' } as never)
    expect(list.items.value).toHaveLength(0)
    expect(list.total.value).toBe(0)
    expect(list.dispose()).toBeUndefined()
  })
})
