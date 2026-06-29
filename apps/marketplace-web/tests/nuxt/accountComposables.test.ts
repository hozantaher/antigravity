import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ItemType, itemStatus, type Item } from '~/models'

import useInvoices from '~/features/sale/invoicing/logic/useInvoices'
import useUserList from '~/features/platform/admin/logic/useUserList'
import useUserDetail from '~/features/platform/admin/logic/useUserDetail'
import useItemDetail from '~/features/supply/auction-items/logic/useItemDetail'
import { useLiveItemStatus } from '~/features/supply/auction-items/logic/useLiveItemStatus'

const { userRef } = vi.hoisted(() => ({ userRef: { value: { id: 'u1' } as { id: string } | null } }))
mockNuxtImport('useUser', () => () => ({ user: userRef, isLogged: { value: true } }))
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

beforeEach(() => vi.clearAllMocks())

describe('useInvoices', () => {
  it('fetches the current page into state', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ items: [{ id: 'inv1' }], total: 1 }))
    const inv = useInvoices()
    await inv.fetchInvoices()
    expect(inv.invoices.value).toEqual([{ id: 'inv1' }])
    expect(inv.total.value).toBe(1)
  })
})

describe('useUserList', () => {
  it('exposes the paged resource fetch', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ items: [{ id: 'u1' }], total: 1 }))
    const ul = useUserList()
    await ul.fetchPage({ page: 1, pageSize: 20 })
    expect(ul.users.value).toEqual([{ id: 'u1' }])
  })

  it('exposes a no-op dispose', () => {
    const ul = useUserList()
    expect(() => ul.dispose()).not.toThrow()
    expect(ul.dispose()).toBeUndefined()
  })
})

describe('useUserDetail', () => {
  it('loads a user with their invoices, then disposes', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ id: 'u1', email: 'a@b.cz' })
      .mockResolvedValueOnce({ items: [{ id: 'i1' }], total: 1 })
    vi.stubGlobal('$fetch', f)
    const ud = useUserDetail()
    await ud.fetchUser('u1')
    expect(ud.user.value).toMatchObject({ id: 'u1' })
    expect(ud.invoices.value).toEqual([{ id: 'i1' }])
    expect(ud.invoicesTotal.value).toBe(1)
    ud.dispose()
    expect(ud.user.value).toBeUndefined()
  })

  it('falls back to an empty invoice page on error', async () => {
    const f = vi.fn().mockResolvedValueOnce({ id: 'u1' }).mockRejectedValueOnce(new Error('boom'))
    vi.stubGlobal('$fetch', f)
    const ud = useUserDetail()
    await ud.fetchUser('u1')
    expect(ud.invoices.value).toEqual([])
  })

  it('deletes a user via the API and toasts success', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('$fetch', f)
    const ud = useUserDetail()
    await ud.deleteUser('u1')
    expect(f).toHaveBeenCalledWith('/api/admin/user/u1', { method: 'DELETE' })
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('emails a password reset for the loaded user', async () => {
    const f = vi.fn().mockResolvedValue({ id: 'u1', items: [], total: 0 })
    vi.stubGlobal('$fetch', f)
    const ud = useUserDetail()
    await ud.fetchUser('u1') // loads user.value so resetPassword has an id
    await ud.resetPassword()
    expect(f).toHaveBeenCalledWith('/api/admin/user/u1/reset-password', { method: 'POST' })
    expect(toast.success).toHaveBeenCalled()
  })

  it('skips the invoice fetch when no user is loaded', async () => {
    const f = vi.fn()
    vi.stubGlobal('$fetch', f)
    const ud = useUserDetail()
    ud.dispose()
    await ud.fetchInvoices()
    expect(f).not.toHaveBeenCalled()
    expect(ud.invoices.value).toBeUndefined()
  })

  it('refetches invoices when the page changes', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ id: 'u1' })
      .mockResolvedValueOnce({ items: [{ id: 'i1' }], total: 5 })
      // Default (not Once): leaked watchers from prior tests on the shared invoicesPage state
      // also fire fetchInvoices on the page change — every extra call must resolve, not return
      // undefined (which would `.catch` on undefined and leave an unhandled rejection).
      .mockResolvedValue({ items: [{ id: 'i2' }], total: 5 })
    vi.stubGlobal('$fetch', f)
    const ud = useUserDetail()
    await ud.fetchUser('u1')
    expect(ud.invoices.value).toEqual([{ id: 'i1' }])

    ud.invoicesPage.value = 2
    await nextTick()
    await flushPromises()
    expect(f).toHaveBeenLastCalledWith(`/api/admin/user/u1/invoices`, {
      query: { page: 2, pageSize: ud.invoicesPageSize },
    })
    expect(ud.invoices.value).toEqual([{ id: 'i2' }])
  })
})

describe('useItemDetail (read mode)', () => {
  it('places a bid and refreshes the shared item', async () => {
    const f = vi.fn().mockResolvedValue({ id: 'i1', bids: [{ amount: 1000 }] })
    vi.stubGlobal('$fetch', f)
    useState<Item | undefined>('itemDetail').value = { id: 'i1' } as Item
    const d = useItemDetail()
    await d.placeBid(1000)
    expect(f).toHaveBeenCalledWith('/api/item/i1/bid', { method: 'POST', body: { amount: 1000, userId: 'u1' } })
    await d.refresh()
    expect(f).toHaveBeenCalledWith('/api/item/i1')
  })
})

describe('useLiveItemStatus', () => {
  it('derives the lifecycle status off the shared ticker', () => {
    const item = { sold: true, type: ItemType.auction, bids: [] } as unknown as Item
    expect(useLiveItemStatus(item).status.value).toBe(itemStatus(item))
  })
})
